/**
 * db.js — Phase 3, batch 4 (Data/DB layer).
 *
 *   1. Database schema extraction + ER-diagram — parses CREATE TABLE
 *      (SQL) and @Entity/@OneToMany/@ManyToOne (JPA) / models.Model
 *      (Django) into a table/column/relationship list, plus a ready-to-
 *      render Mermaid erDiagram string.
 *   2. Orphan table/entity detection — tables/entities with no foreign-key
 *      relationship to anything else AND no code reference outside their
 *      own definition file.
 */

// ---------------------------------------------------------------------
// 1. Schema extraction
// ---------------------------------------------------------------------

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\);/gi;
const COLUMN_LINE_RE = /^\s*[`"']?(\w+)[`"']?\s+([A-Za-z][\w()]*)/;
const FK_RE = /FOREIGN\s+KEY\s*\(?[`"']?(\w+)[`"']?\)?\s+REFERENCES\s+[`"']?(\w+)[`"']?/gi;
const INLINE_FK_RE = /[`"']?(\w+)[`"']?\s+\w+[^,]*REFERENCES\s+[`"']?(\w+)[`"']?/gi;

/** Parses raw SQL (schema.sql, migrations) for CREATE TABLE statements. */
function parseSqlSchema(files) {
    const tables = [];
    files.filter((f) => /\.sql$/i.test(f.path)).forEach((f) => {
        const content = f.content || '';
        let m;
        CREATE_TABLE_RE.lastIndex = 0;
        while ((m = CREATE_TABLE_RE.exec(content)) !== null) {
            const tableName = m[1];
            const body = m[2];
            const columns = [];
            const foreignKeys = [];
            body.split(',').forEach((rawLine) => {
                const line = rawLine.trim();
                if (/^FOREIGN\s+KEY/i.test(line)) {
                    FK_RE.lastIndex = 0;
                    const fkm = FK_RE.exec(line);
                    if (fkm) foreignKeys.push({ column: fkm[1], referencesTable: fkm[2] });
                    return;
                }
                if (/^(PRIMARY\s+KEY|UNIQUE|CONSTRAINT|CHECK|INDEX|KEY)\b/i.test(line)) return;
                const colM = line.match(COLUMN_LINE_RE);
                if (colM) {
                    columns.push({ name: colM[1], type: colM[2] });
                    if (/REFERENCES\s+[`"']?(\w+)/i.test(line)) {
                        const refM = line.match(/REFERENCES\s+[`"']?(\w+)/i);
                        if (refM) foreignKeys.push({ column: colM[1], referencesTable: refM[1] });
                    }
                }
            });
            tables.push({ name: tableName, file: f.path, columns, foreignKeys, source: 'sql' });
        }
    });
    return tables;
}

/** Parses JPA @Entity classes for table name + column/relationship info. */
function parseJpaEntities(files) {
    const tables = [];
    files.filter((f) => /\.java$/.test(f.path) && /@Entity\b/.test(f.content || '')).forEach((f) => {
        const content = f.content;
        const classM = content.match(/class\s+(\w+)/);
        const tableM = content.match(/@Table\s*\(\s*name\s*=\s*["'](\w+)["']/);
        const name = tableM ? tableM[1] : (classM ? classM[1] : f.path.split('/').pop());

        const columns = [];
        const fieldRe = /@Column(?:\([^)]*\))?\s*\n\s*(?:private|public|protected)\s+\w+(?:<[\w,\s]+>)?\s+(\w+)/g;
        let cm;
        while ((cm = fieldRe.exec(content)) !== null) columns.push({ name: cm[1], type: 'unknown' });

        const foreignKeys = [];
        const relRe = /@(ManyToOne|OneToOne)(?:\([^)]*\))?\s*\n(?:\s*@\w+(?:\([^)]*\))?\s*\n)*\s*(?:private|public|protected)\s+(\w+)\s+(\w+)/g;
        let rm;
        while ((rm = relRe.exec(content)) !== null) foreignKeys.push({ column: rm[3], referencesTable: rm[2] });

        tables.push({ name, file: f.path, columns, foreignKeys, source: 'jpa' });
    });
    return tables;
}

/** Parses Django models.Model subclasses. */
function parseDjangoModels(files) {
    const tables = [];
    files.filter((f) => /\.py$/.test(f.path) && /models\.Model\)/.test(f.content || '')).forEach((f) => {
        const content = f.content;
        const classRe = /class\s+(\w+)\(models\.Model\)\s*:([\s\S]*?)(?=\nclass\s+\w|\Z)/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const name = m[1];
            const body = m[2];
            const columns = [];
            const foreignKeys = [];
            const fieldRe = /(\w+)\s*=\s*models\.(\w+Field)\(([^)]*)\)/g;
            let fm;
            while ((fm = fieldRe.exec(body)) !== null) {
                columns.push({ name: fm[1], type: fm[2] });
                if (fm[2] === 'ForeignKey' || fm[2] === 'OneToOneField') {
                    const refM = fm[3].match(/^['"](\w+)['"]|^(\w+)/);
                    if (refM) foreignKeys.push({ column: fm[1], referencesTable: refM[1] || refM[2] });
                }
            }
            tables.push({ name, file: f.path, columns, foreignKeys, source: 'django' });
        }
    });
    return tables;
}

/** Renders a Mermaid `erDiagram` block from the extracted table list. */
function toMermaidErDiagram(tables) {
    const lines = ['erDiagram'];
    tables.forEach((t) => {
        t.foreignKeys.forEach((fk) => {
            const target = tables.find((x) => x.name.toLowerCase() === String(fk.referencesTable).toLowerCase());
            if (target) lines.push(`    ${t.name} }o--|| ${target.name} : "${fk.column}"`);
        });
    });
    tables.forEach((t) => {
        if (!t.columns.length) return;
        lines.push(`    ${t.name} {`);
        t.columns.slice(0, 12).forEach((c) => lines.push(`        ${c.type.replace(/[^\w]/g, '_') || 'string'} ${c.name}`));
        lines.push('    }');
    });
    return lines.join('\n');
}

export function extractDatabaseSchema(files) {
    const tables = [...parseSqlSchema(files), ...parseJpaEntities(files), ...parseDjangoModels(files)];
    return {
        tables,
        mermaidErDiagram: tables.length ? toMermaidErDiagram(tables) : null,
        confidence: 'FACT',
        confidenceReason: 'Tables/columns/foreign keys parsed directly from CREATE TABLE SQL, @Entity/@Column/@ManyToOne annotations, or Django models.Model field declarations.',
    };
}

// ---------------------------------------------------------------------
// 2. Orphan table/entity detection
// ---------------------------------------------------------------------

/**
 * Flags tables with no FK relationship in either direction AND no
 * reference to the table/class name anywhere outside its own defining
 * file — likely dead schema (leftover from a removed feature) or a
 * genuinely standalone lookup table. Tagged UNCERTAIN since "no text
 * reference found" can't rule out dynamic/reflective access.
 */
export function detectOrphanTables(tables, files) {
    const referencedAsFkTarget = new Set();
    tables.forEach((t) => t.foreignKeys.forEach((fk) => referencedAsFkTarget.add(String(fk.referencesTable).toLowerCase())));

    const hasOutgoingFk = new Set(tables.filter((t) => t.foreignKeys.length > 0).map((t) => t.name.toLowerCase()));

    return tables
        .filter((t) => !referencedAsFkTarget.has(t.name.toLowerCase()) && !hasOutgoingFk.has(t.name.toLowerCase()))
        .map((t) => {
            const re = new RegExp(`\\b${t.name}\\b`, 'i');
            const referencingFiles = files.filter((f) => f.path !== t.file && re.test(f.content || ''));
            return {
                table: t.name, file: t.file,
                referencedElsewhere: referencingFiles.length > 0,
                referencingFileCount: referencingFiles.length,
                confidence: 'UNCERTAIN',
                confidenceReason: referencingFiles.length
                    ? 'No FK relationship found, but the table/class name does appear in other files — likely used via raw queries or dynamic access, not a true orphan.'
                    : 'No FK relationship and no textual reference found elsewhere in the repo — possibly unused, but dynamic/reflective access or references outside this upload can\'t be ruled out.',
            };
        })
        .filter((t) => !t.referencedElsewhere);
}
