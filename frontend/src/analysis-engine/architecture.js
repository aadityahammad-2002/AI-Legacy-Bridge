/**
 * architecture.js — Phase 3, batch 3 (Architecture-level insights).
 * Seven items, one file because they all read the same inputs
 * (files, dependencies, connections, roles, layerViolations).
 */

// ---------------------------------------------------------------------
// Module boundary analysis
// ---------------------------------------------------------------------

function moduleOf(path) {
    const parts = path.split('/');
    // Skip common non-semantic roots so "src/main/java/com/x/orders/..." groups
    // by "orders", not "src". Best-effort, heuristic by nature.
    const skip = new Set(['src', 'main', 'java', 'kotlin', 'com', 'org', 'app', 'lib']);
    const meaningful = parts.filter((p) => !skip.has(p));
    return meaningful.length > 1 ? meaningful[0] : (parts[0] || 'root');
}

/**
 * Groups files into modules (top meaningful path segment) and counts
 * cross-module dependency edges. A module with many *inbound* modules
 * touching it is a shared/foundational module; one with many *outbound*
 * edges into others has weak boundaries (it reaches into everything).
 */
export function computeModuleBoundaries({ files, dependencies }) {
    const moduleOfFile = new Map(files.map((f) => [f.path, moduleOf(f.path)]));
    const edgeCounts = new Map(); // "modA->modB" -> count
    dependencies.forEach((d) => {
        const from = moduleOfFile.get(d.target); // target depends on source (per convention used elsewhere)
        const to = moduleOfFile.get(d.source);
        if (!from || !to || from === to) return;
        const key = `${from}->${to}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    });

    const outboundByModule = new Map();
    edgeCounts.forEach((count, key) => {
        const [from] = key.split('->');
        outboundByModule.set(from, (outboundByModule.get(from) || new Set()));
        outboundByModule.get(from).add(key.split('->')[1]);
    });

    const modules = [...new Set(moduleOfFile.values())].map((name) => ({
        name,
        fileCount: [...moduleOfFile.values()].filter((m) => m === name).length,
        touchesModules: outboundByModule.has(name) ? outboundByModule.get(name).size : 0,
    }));

    const edges = [...edgeCounts.entries()].map(([key, count]) => {
        const [from, to] = key.split('->');
        return { from, to, count };
    });

    // Weak-boundary flag: a module reaching directly into 4+ other modules.
    const weakBoundaries = modules.filter((m) => m.touchesModules >= 4);

    return {
        modules, edges, weakBoundaries,
        confidence: 'INFERENCE',
        confidenceReason: 'Module = top meaningful path segment (heuristic) — real module boundaries may not follow the folder layout.',
    };
}

// ---------------------------------------------------------------------
// Business-Domain Clustering (naming-token based, folder-independent)
// ---------------------------------------------------------------------

const ROLE_SUFFIXES = /(Controller|Service|Repository|Repo|DAO|Entity|Model|DTO|Dto|Request|Response|Payload|Mapper|Factory|Validator|Handler|Listener|Config|Middleware|Interceptor|Filter|Impl|Test|Tests)$/;

function domainToken(baseName) {
    const noExt = baseName.replace(/\.[^.]+$/, '');
    const stripped = noExt.replace(ROLE_SUFFIXES, '');
    return stripped || noExt;
}

/**
 * Clusters files by shared naming token after stripping role suffixes —
 * e.g. UserController.java, UserService.java, user_repository.py, UserDto.ts
 * all reduce to token "User" regardless of which folder they live in.
 */
export function computeDomainClusters(files, minClusterSize = 2) {
    const byToken = new Map();
    files.forEach((f) => {
        const base = f.path.split('/').pop();
        const token = domainToken(base).toLowerCase().replace(/[_-]/g, '');
        if (!token || token.length < 3) return;
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token).push(f.path);
    });

    const clusters = [...byToken.entries()]
        .filter(([, paths]) => paths.length >= minClusterSize)
        .map(([token, paths]) => ({ domain: token, files: paths, confidence: 'INFERENCE',
            confidenceReason: `${paths.length} files share the naming token "${token}" after stripping role suffixes (Controller/Service/etc.) — a naming convention, not a verified domain boundary.` }))
        .sort((a, b) => b.files.length - a.files.length);

    return clusters;
}

// ---------------------------------------------------------------------
// Architecture Drift Detection
// ---------------------------------------------------------------------

/**
 * Summarizes how much the codebase's actual call/import graph deviates
 * from expected layering (ui -> services -> data, never the reverse),
 * reusing the layerViolations the engine already computes. Adds a
 * repo-wide drift percentage and names the worst-offending files.
 */
export function computeArchitectureDrift({ layerViolations, connections }) {
    const total = connections.length || 1;
    const violationCount = (layerViolations || []).length;
    const driftPct = Math.round((violationCount / total) * 100);

    const offenderCounts = new Map();
    (layerViolations || []).forEach((v) => {
        offenderCounts.set(v.from, (offenderCounts.get(v.from) || 0) + 1);
    });
    const worstOffenders = [...offenderCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file, count]) => ({ file, violationCount: count }));

    let level = 'low';
    if (driftPct >= 20) level = 'high';
    else if (driftPct >= 8) level = 'medium';

    return {
        violationCount, totalConnections: connections.length, driftPct, level, worstOffenders,
        confidence: 'FACT',
        confidenceReason: 'Computed directly from layer violations already detected by parsing import/call direction against each file\'s detected layer.',
    };
}

// ---------------------------------------------------------------------
// Config-to-Code Linkage (env vars <-> actual config files)
// ---------------------------------------------------------------------

const CONFIG_FILE_RE = /\.(env|properties|ya?ml)$/i;
const CONFIG_KEY_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*[:=]\s*(.*)$/;

const CODE_REF_PATTERNS = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    /os\.environ(?:\.get)?\(?\[?['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /System\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /@Value\(\s*"\$\{([A-Za-z0-9_.]+)/g,
];

/** Extracts KEY=/KEY: entries from .env/.properties/.yml config files. */
function extractConfigKeys(files) {
    const keys = new Map(); // key -> [{file, line, value}]
    files.filter((f) => CONFIG_FILE_RE.test(f.path)).forEach((f) => {
        (f.content || '').split('\n').forEach((line, idx) => {
            if (/^\s*#/.test(line) || !line.trim()) return;
            const m = line.match(CONFIG_KEY_LINE_RE);
            if (!m) return;
            const key = m[1];
            if (!keys.has(key)) keys.set(key, []);
            keys.get(key).push({ file: f.path, line: idx + 1, value: m[2].trim() });
        });
    });
    return keys;
}

/**
 * Links config keys to where they're actually read in code. Flags keys
 * defined but never referenced (dead config) and, separately, common env
 * var reads that don't match any defined key (possibly defined only in a
 * deployment environment outside the repo — tagged UNCERTAIN, not "missing").
 */
export function computeConfigToCodeLinkage(files) {
    const definedKeys = extractConfigKeys(files);
    const referencedKeys = new Map(); // key -> [{file, line}]

    files.forEach((f) => {
        if (CONFIG_FILE_RE.test(f.path)) return;
        const content = f.content || '';
        CODE_REF_PATTERNS.forEach((re) => {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(content)) !== null) {
                const key = m[1];
                if (!referencedKeys.has(key)) referencedKeys.set(key, []);
                referencedKeys.get(key).push({ file: f.path, line: lineOf(content, m.index) });
            }
        });
    });

    const links = [];
    definedKeys.forEach((defs, key) => {
        const refs = referencedKeys.get(key) || [];
        links.push({
            key, definedIn: defs, referencedIn: refs, unused: refs.length === 0,
            confidence: 'FACT', confidenceReason: 'Config key definition matched directly in a .env/.properties/.yml file; references matched by direct pattern search in source.',
        });
    });

    const referencedButNotDefined = [...referencedKeys.keys()].filter((k) => !definedKeys.has(k)).map((key) => ({
        key, referencedIn: referencedKeys.get(key),
        confidence: 'UNCERTAIN', confidenceReason: 'Read in code but no matching key found in this repo\'s config files — may be set in a deployment environment, secrets manager, or a config file outside this upload.',
    }));

    return { links, referencedButNotDefined };
}

function lineOf(content, index) {
    return content.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------
// External-System Boundary Detection
// ---------------------------------------------------------------------

const BOUNDARY_SIGNALS = [
    { type: 'HTTP client', re: /axios\.|fetch\(|requests\.(get|post|put|delete)|RestTemplate|WebClient|HttpClient|OkHttpClient/ },
    { type: 'Database client', re: /JdbcTemplate|EntityManager|mongoose\.connect|createConnection\(|psycopg2\.connect|sqlalchemy|new Pool\(|redis\.createClient/ },
    { type: 'Message queue', re: /kafka|KafkaTemplate|amqp|RabbitTemplate|SQS|sqs\.|pubsub|PubSub/i },
    { type: 'File/Storage', re: /S3Client|new AWS\.S3|createReadStream|fs\.(readFile|writeFile)/ },
];

/** Flags files that call out to external systems, and which kind. */
export function computeExternalBoundaries(files) {
    const boundaries = [];
    files.forEach((f) => {
        const content = f.content || '';
        const matched = BOUNDARY_SIGNALS.filter((s) => s.re.test(content)).map((s) => s.type);
        if (matched.length) {
            boundaries.push({
                file: f.path, types: matched,
                confidence: 'INFERENCE',
                confidenceReason: 'Matched known client library/API call patterns in source — confirms the dependency exists, not necessarily every call site.',
            });
        }
    });
    return boundaries;
}

// ---------------------------------------------------------------------
// Error-Handling Coverage per Flow
// ---------------------------------------------------------------------

function errorHandlingRatio(content) {
    if (!content) return { hasHandling: false, tryCount: 0 };
    const tryCatch = (content.match(/\btry\s*[{:]/g) || []).length;
    const exceptBlocks = (content.match(/\bexcept\b/g) || []).length;
    const rescue = (content.match(/\brescue\b/g) || []).length;
    const total = tryCatch + exceptBlocks + rescue;
    return { hasHandling: total > 0, tryCount: total };
}

/**
 * For each traced flow (Phase 2's flowTraces), reports what fraction of the
 * hops have visible error handling in the file, so "this request path has
 * no error handling from Controller to Repository" becomes answerable.
 */
export function computeErrorHandlingCoverage(flowTraces, filesByPath) {
    return flowTraces.map((trace) => {
        const hops = trace.chain.map((hop) => {
            const file = filesByPath.get(hop.file);
            const { hasHandling, tryCount } = errorHandlingRatio(file?.content);
            return { file: hop.file, role: hop.role, hasHandling, tryCount };
        });
        const covered = hops.filter((h) => h.hasHandling).length;
        return {
            startFile: trace.startFile,
            hops,
            coveragePct: hops.length ? Math.round((covered / hops.length) * 100) : 0,
            confidence: 'INFERENCE',
            confidenceReason: 'Presence of try/catch/except/rescue blocks anywhere in the file is used as a proxy for error handling on this specific call path — not verified to wrap the exact call.',
        };
    });
}

// ---------------------------------------------------------------------
// Data Ownership Mapping (Service <-> Entity writes)
// ---------------------------------------------------------------------

const WRITE_VERBS = /^(save|delete|remove|update|insert|create|persist|write|upsert)/i;

/**
 * Maps which Service (or Controller, if it writes directly) calls a
 * write-verb function on a Repository/Entity-layer file — "who owns
 * writing this data".
 */
export function computeDataOwnership({ connections, roles }) {
    const ownership = [];
    connections.forEach((c) => {
        const callerRole = roles[c.target]?.role;
        const calleeRole = roles[c.source]?.role;
        if (!WRITE_VERBS.test(c.fn || '')) return;
        if (calleeRole !== 'Repository' && calleeRole !== 'Entity/Model') return;
        ownership.push({
            writer: c.target, writerRole: callerRole || 'Other',
            target: c.source, targetRole: calleeRole,
            fn: c.fn,
            confidence: 'INFERENCE',
            confidenceReason: `Function name "${c.fn}" matches a write-verb naming convention and calls into a ${calleeRole} file — inferred write, not confirmed by data-flow analysis.`,
        });
    });
    return ownership;
}
