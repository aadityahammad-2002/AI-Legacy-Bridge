/**
 * Bounded cross-system static evidence: literal message-channel operations and
 * literal SQL operations. Each detection requires an executable-looking call
 * site rather than merely encountering a name in a comment or documentation.
 * These are candidate paths, not observed message delivery or DB execution.
 */
import { identifyCodeLanguage, maskLanguageNonCode } from './languageIntelligence.js';
const METHODS = [
    { side: 'publish', api: 'kafka-producer', rx: /\b(?:kafkaTemplate|kafkaProducer)\s*\.\s*(?:send|produce|publish)\s*\(\s*(['"`])([\w./:-]{1,150})\1/g },
    { side: 'publish', api: 'generic-producer', rx: /\bproducer\s*\.\s*(?:send|produce|publish)\s*\(\s*(['"`])([\w./:-]{1,150})\1/g },
    { side: 'publish', api: 'channel-publish', rx: /\b(?:channel|publisher|eventBus)\s*\.\s*(?:publish|emit)\s*\(\s*(['"`])([\w./:-]{1,150})\1/g },
    { side: 'subscribe', api: 'channel-subscribe', rx: /\b(?:channel|eventBus)\s*\.\s*(?:subscribe|on|listen)\s*\(\s*(?:\[\s*)?(['"`])([\w./:-]{1,150})\1/g },
    { side: 'subscribe', api: 'generic-consumer', rx: /\bconsumer\s*\.\s*(?:subscribe|on|listen)\s*\(\s*(?:\[\s*)?(['"`])([\w./:-]{1,150})\1/g },
    { side: 'subscribe', api: 'kafka-listener', rx: /@KafkaListener\s*\(\s*(?:topics\s*=\s*)?(?:\{\s*)?(['"])([\w./:-]{1,150})\1/g },
    { side: 'subscribe', api: 'python-kafka-consumer', rx: /\bKafkaConsumer\s*\(\s*(['"])([\w./:-]{1,150})\1/g },
];
const transportFor = api => api.includes('kafka') ? 'kafka' : api.startsWith('generic-') ? 'unknown-transport' : 'application-event';
const SQL_CALL = /\b(?:cursor|connection|conn|db|database|pool|client|session|entityManager)\s*\.\s*(?:execute|query|exec|run|raw)\s*\(\s*(['"`])((?:SELECT|INSERT|UPDATE|DELETE)\b[^'"`\n]{0,300})\1/gi;
const SQL_TABLE = { SELECT: /\bFROM\s+([\w."`]+)/i, INSERT: /\bINTO\s+([\w."`]+)/i,
    UPDATE: /^UPDATE\s+([\w."`]+)/i, DELETE: /\bFROM\s+([\w."`]+)/i };

function validCallSite(masked, match) {
    // Masking blanks comments and strings, so only inspect the exact call
    // prefix *before* its first captured quote. Never scan trailing lines:
    // that could mistakenly validate a commented-out call with later code.
    const quoteOffset = match[0].indexOf(match[1]);
    if (quoteOffset < 0) return false;
    const prefix = masked.slice(match.index, match.index + quoteOffset);
    return /[A-Za-z][\w.]*\s*\(/.test(prefix) || /@KafkaListener\s*\(/.test(prefix);
}
function lineOf(source, offset) { return source.slice(0, offset).split('\n').length; }

export function analyzeCrossSystemIntelligence(files = [], databaseSchema = {}, options = {}) {
    const maxOperations = Math.max(1, Math.min(10000, Number(options.maxOperations) || 1500));
    const maxLinks = Math.max(1, Math.min(20000, Number(options.maxLinks) || 2000));
    const messages = [], sql = [];
    let truncated = false;
    for (const file of files) {
        if (typeof file.content !== 'string') continue;
        const lang = identifyCodeLanguage(file.path);
        if (!lang) continue;
        const source = file.content;
        const masked = maskLanguageNonCode(source, lang);
        for (const method of METHODS) {
            for (const match of source.matchAll(method.rx)) {
                if (messages.length >= maxOperations) { truncated = true; break; }
                if (!validCallSite(masked, match)) continue;
                messages.push({ side: method.side, api: method.api, transport: transportFor(method.api), channel: match[2],
                    file: file.path, line: lineOf(source, match.index), confidence: 'medium',
                    provenance: 'source-literal-message-api' });
            }
        }
        for (const match of source.matchAll(SQL_CALL)) {
            if (sql.length >= maxOperations) { truncated = true; break; }
            if (!validCallSite(masked, match)) continue;
            const operation = match[2].trim().split(/\s+/)[0].toUpperCase();
            const table = match[2].match(SQL_TABLE[operation])?.[1]?.replace(/["`]/g, '') || null;
            sql.push({ operation, table, file: file.path, line: lineOf(source, match.index),
                confidence: table ? 'medium' : 'low', provenance: 'literal-sql-query-call' });
        }
    }
    const subscribers = new Map();
    for (const m of messages) {
        if (m.side !== 'subscribe') continue;
        const key = `${m.transport}|${m.channel}`;
        if (!subscribers.has(key)) subscribers.set(key, []);
        subscribers.get(key).push(m);
    }
    const links = [];
    let unmatchedPublishers = 0, ambiguousChannels = 0;
    for (const m of messages.filter(item => item.side === 'publish')) {
        // Generic producer/consumer objects do not prove they use the same broker.
        if (m.transport === 'unknown-transport') { unmatchedPublishers++; continue; }
        const targets = (subscribers.get(`${m.transport}|${m.channel}`) || []).filter(target =>
            !(target.file === m.file && target.line === m.line));
        if (!targets.length) { unmatchedPublishers++; continue; }
        if (targets.length > 1) { ambiguousChannels++; continue; }
        if (links.length >= maxLinks) { truncated = true; break; }
        links.push({ channel: m.channel, transport: m.transport, source: { file: m.file, line: m.line },
            target: { file: targets[0].file, line: targets[0].line },
            resolution: 'static-literal-candidate', confidence: 'low',
            caveat: 'Matching channel names do not establish broker, namespace, deployment, or runtime message delivery.' });
    }
    const knownTables = new Map();
    for (const table of databaseSchema?.tables || []) {
        const key = String(table.name || '').toLowerCase();
        if (!knownTables.has(key)) knownTables.set(key, []);
        knownTables.get(key).push(table);
    }
    // Do not pick an arbitrary schema when duplicate table names exist.
    const ambiguousSchemaMatches = sql.filter(item => item.table && (knownTables.get(item.table.toLowerCase()) || []).length > 1).length;
    const databaseLinks = sql.filter(item => item.table && (knownTables.get(item.table.toLowerCase()) || []).length === 1)
        .slice(0, maxLinks).map(item => {
            const table = knownTables.get(item.table.toLowerCase())[0];
            return { source: { file: item.file, line: item.line },
                target: { name: table.name, file: table.file }, operation: item.operation,
                confidence: 'medium', resolution: 'literal-query-to-unique-declared-table' };
        });
    return {
        schemaVersion: 1, status: truncated ? 'bounded' : 'partial',
        summary: { detectedMessageOperations: messages.length, candidateMessageLinks: links.length,
            unmatchedPublishers, ambiguousChannels, ambiguousSchemaMatches, literalSqlOperations: sql.length, matchedSchemaTables: databaseLinks.length },
        messages, messageLinks: links, sqlOperations: sql, databaseLinks, truncated,
        semantics: 'Static literal message and SQL callsite candidates only. No broker configuration, dynamic queries, ORM dispatch, runtime instrumentation, or actual database operations are verified.',
    };
}
