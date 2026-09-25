/**
 * roles.js — Phase 2 of the 48-item roadmap.
 *
 *   1. Architectural Role Classification — auto-detects Controller /
 *      Service / Repository / Entity / DTO / Middleware / Config / Util
 *      per file, using framework annotations/base-classes where available
 *      (FACT) and filename/path conventions as a fallback (INFERENCE).
 *      Folder-independent: two files named `UserService.java` and
 *      `foo/bar/baz/UserService.java` classify the same way.
 *
 *   2. Execution/Request-Flow Tracing — given an entry point (typically a
 *      Controller/route file from Phase 1's entryPoints), walks the
 *      call-graph `connections` forward (caller -> callee) and produces a
 *      human-readable chain, e.g. Controller -> Service -> Repository,
 *      each hop labeled with its role from #1 above.
 */

// ---------------------------------------------------------------------
// 1. Architectural Role Classification
// ---------------------------------------------------------------------

// Order matters: checked top to bottom, first match wins. Annotation/base-class
// signals (FACT) are listed before naming-convention-only signals (INFERENCE).
const ROLE_RULES = [
    { role: 'Controller', confidence: 'FACT', test: (c) => /@RestController|@Controller\b/.test(c) },
    { role: 'Controller', confidence: 'FACT', test: (c) => /@(app|router|blueprint)\.(route|get|post|put|delete|patch)\s*\(/.test(c) },
    { role: 'Controller', confidence: 'FACT', test: (c) => /express\.Router\s*\(\)|@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]/.test(c) },

    { role: 'Middleware', confidence: 'FACT', test: (c) => /function\s*\w*\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)|@app\.middleware\s*\(/.test(c) },

    { role: 'Repository', confidence: 'FACT', test: (c) => /@Repository\b|extends\s+(?:Jpa|Crud|Paging(?:AndSorting)?)Repository/.test(c) },
    { role: 'Repository', confidence: 'FACT', test: (c) => /class\s+\w+\(models\.Manager\)|objects\s*=\s*models\.Manager\(\)/.test(c) },

    { role: 'Service', confidence: 'FACT', test: (c) => /@Service\b/.test(c) },

    { role: 'Entity/Model', confidence: 'FACT', test: (c) => /@Entity\b|@Table\s*\(/.test(c) },
    { role: 'Entity/Model', confidence: 'FACT', test: (c) => /class\s+\w+\(models\.Model\)/.test(c) },
    { role: 'Entity/Model', confidence: 'FACT', test: (c) => /\(Base\)\s*:|declarative_base\s*\(/.test(c) },

    { role: 'DTO', confidence: 'FACT', test: (c) => /class\s+\w+\(BaseModel\)|@dataclass/.test(c) },

    { role: 'Config', confidence: 'FACT', test: (c) => /@Configuration\b|@SpringBootApplication\b/.test(c) },
];

// Filename/path fallback (INFERENCE — naming convention only, folder-independent
// per item #34's "folder-independent" requirement: matched against the base
// filename, not the directory).
const NAME_RULES = [
    { role: 'Controller', re: /controller|resource|endpoint/i },
    { role: 'Service', re: /service|usecase|manager/i },
    { role: 'Repository', re: /repository|repo|dao/i },
    { role: 'Entity/Model', re: /entity|model(?!.*test)/i },
    { role: 'DTO', re: /dto|request|response|payload/i },
    { role: 'Middleware', re: /middleware|interceptor|filter/i },
    { role: 'Config', re: /config|settings/i },
    { role: 'Util', re: /util|helper|common/i },
];

function isTestFile(path) {
    const p = path.toLowerCase();
    return p.includes('/test') || /test_\w+\.py$/.test(p) || /\w+_test\.py$/.test(p) || /\.(spec|test)\.[jt]sx?$/.test(p);
}

/**
 * Classifies a single file's architectural role. Content-based rules (FACT)
 * are tried first; if none match, falls back to filename convention
 * (INFERENCE). A file that matches neither is 'Other' (UNCERTAIN — we
 * genuinely don't know, not a claim that it has no role).
 */
export function classifyFileRole(file) {
    if (isTestFile(file.path)) {
        return { role: 'Test', confidence: 'FACT', reason: 'Path/name matches test-file convention.' };
    }

    const content = file.content || '';
    for (const rule of ROLE_RULES) {
        if (rule.test(content)) {
            return { role: rule.role, confidence: rule.confidence, reason: `Matched framework annotation/base-class for ${rule.role}.` };
        }
    }

    const baseName = file.path.split('/').pop();
    for (const rule of NAME_RULES) {
        if (rule.re.test(baseName)) {
            return { role: rule.role, confidence: 'INFERENCE', reason: `Filename "${baseName}" matches the ${rule.role} naming convention — no framework annotation found to confirm.` };
        }
    }

    return { role: 'Other', confidence: 'UNCERTAIN', reason: 'No framework annotation or naming convention matched a known architectural role.' };
}

/** Classifies every file, returns a map keyed by file path. */
export function computeRoleClassification(files) {
    const map = {};
    files.forEach((file) => {
        map[file.path] = classifyFileRole(file);
    });
    return map;
}

// ---------------------------------------------------------------------
// 2. Execution / Request-Flow Tracing
// ---------------------------------------------------------------------

/**
 * Traces the call chain forward from a starting file (e.g. a Controller /
 * route entry point). `connections` follow buildCallGraph's convention:
 * { source: fileDefiningTheFunction, target: fileCallingIt, fn, count }.
 * So to walk FORWARD from a caller to what it calls, at each step we look
 * for connections whose `target` is the current file, and step into their
 * `source` (the file that defines the function being called).
 *
 * Picks the highest-`count` (most-called) edge at each hop to keep the
 * trace to one representative path rather than branching into every
 * possible call — this is a "typical request path" illustration, not an
 * exhaustive graph, so it's tagged INFERENCE throughout.
 */
export function traceFlow(startFile, connections, roleMap, maxDepth = 6) {
    const visited = new Set([startFile]);
    const chain = [{
        file: startFile,
        role: roleMap[startFile]?.role || 'Other',
        via: null,
    }];

    let current = startFile;
    for (let depth = 0; depth < maxDepth; depth++) {
        const candidates = connections
            .filter((c) => c.target === current && !visited.has(c.source))
            .sort((a, b) => (b.count || 0) - (a.count || 0));

        if (!candidates.length) break;
        const next = candidates[0];
        visited.add(next.source);
        chain.push({
            file: next.source,
            role: roleMap[next.source]?.role || 'Other',
            via: { fn: next.fn, count: next.count },
        });
        current = next.source;
    }

    return {
        startFile,
        chain,
        confidence: 'INFERENCE',
        confidenceReason: 'Follows the most-frequently-called path at each hop from the static call graph — actual runtime branching (conditionals, dynamic dispatch) may differ.',
    };
}

/**
 * Produces flow traces for the top N entry points (from Phase 1's
 * computeEntryPoints), so the UI can show "here's roughly what happens
 * when this request comes in" without the user having to pick a file first.
 */
export function computeFlowTraces(entryPoints, connections, roleMap, limit = 5) {
    return entryPoints.slice(0, limit).map((ep) => traceFlow(ep.file, connections, roleMap));
}
