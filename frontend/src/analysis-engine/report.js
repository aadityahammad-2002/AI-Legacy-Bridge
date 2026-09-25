/**
 * report.js — Phase 3, batch 8 (Documentation).
 *
 * Auto-generated architecture report: aggregates everything the engine
 * already computed (Phases 1-3) into one readable Markdown document a
 * team can export/share, rather than a raw data dump. Every section
 * carries forward the confidence tags of the data it summarizes instead
 * of re-asserting them as certain.
 */

function fmtPct(n) { return `${n}%`; }

function section(title, body) {
    return `## ${title}\n\n${body}\n`;
}

function list(items, empty = '_None found._') {
    if (!items.length) return empty;
    return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Builds the Markdown report. `data` is the full object analyzeRepository
 * returns (or a subset — every section guards for missing fields so this
 * still produces a partial report if some phases were skipped/failed).
 */
export function generateArchitectureReport(repoMeta, data) {
    const {
        healthScore: health, languageStats, entryPoints = [], importantFiles = [], roles = {},
        moduleBoundaries = {}, domainClusters = [], architectureDrift = {},
        apiEndpoints = [], authCoverage = {}, databaseSchema = {}, orphanTables = [],
        dependencyInventory = {}, licenseCompliance = {}, migrationRisk = {},
        issues = [], securityIssues = [], files = [],
    } = data;

    const roleCounts = Object.values(roles).reduce((acc, r) => { acc[r.role] = (acc[r.role] || 0) + 1; return acc; }, {});

    const md = [];
    md.push(`# Architecture Report — ${repoMeta?.name || 'Repository'}`);
    md.push(`_Auto-generated. Confidence tags (FACT/INFERENCE/UNCERTAIN) on the underlying findings are preserved in the full analysis data; this report summarizes them._\n`);

    if (health) {
        md.push(section('Health Overview', `**Score:** ${health.score ?? 'n/a'}/100  \n**Files:** ${files.length}  \n**Open issues:** ${issues.length}  \n**Security findings:** ${securityIssues.length}`));
    }

    md.push(section('Where to Start Reading',
        entryPoints.length
            ? list(entryPoints.slice(0, 8).map((e) => `**${e.file}** (${e.confidence}) — ${e.reasons.join('; ')}`))
            : 'No clear entry points detected.'));

    md.push(section('5 Most Important Files',
        list(importantFiles.map((f) => `**${f.file}** — ${f.reason}`))));

    md.push(section('Architectural Roles',
        Object.entries(roleCounts).map(([role, count]) => `- ${role}: ${count} file(s)`).join('\n') || '_No roles classified._'));

    md.push(section('Business-Domain Clusters',
        list(domainClusters.slice(0, 10).map((c) => `**${c.domain}** — ${c.files.length} files`))));

    md.push(section('Module Boundaries',
        `${(moduleBoundaries.modules || []).length} module(s) detected.\n\n` +
        (moduleBoundaries.weakBoundaries?.length
            ? `**Weak boundaries:** ${list(moduleBoundaries.weakBoundaries.map((m) => `${m.name} (reaches into ${m.touchesModules} other modules)`))}`
            : '_No weak module boundaries detected._')));

    md.push(section('Architecture Drift',
        `**Layer-violation rate:** ${fmtPct(architectureDrift.driftPct ?? 0)} (${architectureDrift.level ?? 'n/a'})  \n` +
        (architectureDrift.worstOffenders?.length
            ? `**Worst offenders:** ${list(architectureDrift.worstOffenders.map((o) => `${o.file} (${o.violationCount} violation(s))`))}`
            : '_No repeat offenders._')));

    md.push(section('API Surface',
        `**${apiEndpoints.length} endpoint(s) discovered.** Auth coverage: ${fmtPct(authCoverage.coveragePct ?? 0)} ` +
        `(${authCoverage.protectedCount ?? 0}/${authCoverage.totalEndpoints ?? 0} protected).\n\n` +
        list(apiEndpoints.slice(0, 15).map((e) => `\`${e.method} ${e.path}\` — ${e.file}${e.authProtected ? ' 🔒' : ' 🔓'}`))));

    if ((databaseSchema.tables || []).length) {
        md.push(section('Data Model',
            `**${databaseSchema.tables.length} table(s)/entity(ies) detected.**\n\n` +
            list(databaseSchema.tables.map((t) => `${t.name} (${t.columns.length} columns, ${t.foreignKeys.length} FK(s)) — \`${t.file}\``)) +
            (orphanTables.length ? `\n\n**Possibly orphaned:** ${list(orphanTables.map((o) => o.table))}` : '')));
    }

    md.push(section('Dependencies',
        `**${dependencyInventory.totalCount ?? 0} third-party dependencies** across ${Object.keys(dependencyInventory.byEcosystem || {}).join(', ') || 'n/a'}.\n\n` +
        (licenseCompliance.copyleftFlags?.length
            ? `⚠️ **Copyleft-licensed dependencies found:** ${list(licenseCompliance.copyleftFlags.map((c) => `${c.name} (${c.license})`))}`
            : '_No copyleft licenses identified (see licenseCompliance for what could not be verified)._') +
        `\n\n_${licenseCompliance.unknownCount ?? 0} dependencies have an unverified license — this check is offline/best-effort, not a full compliance audit._`));

    const highRiskFiles = Object.entries(migrationRisk).filter(([, r]) => r.level === 'critical' || r.level === 'high');
    if (highRiskFiles.length) {
        md.push(section('Highest Migration/Change Risk',
            list(highRiskFiles.slice(0, 10).map(([file, r]) => `**${file}** — ${r.level} (score ${r.score}/100)`))));
    }

    return md.join('\n');
}
