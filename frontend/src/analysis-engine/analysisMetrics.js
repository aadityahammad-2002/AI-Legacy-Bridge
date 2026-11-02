import { buildFindingActionPlan } from './findingQuality.js';

function pct(numerator, denominator) {
    return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}
function languageFor(path) {
    const ext = String(path || '').toLowerCase().split('.').pop();
    const groups = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', vue: 'vue', svelte: 'svelte',
        py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rb: 'ruby', php: 'php', rs: 'rust',
        c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', scala: 'scala',
        sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', sql: 'sql', html: 'html', htm: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css',
        pyw: 'python', pyi: 'python', clj: 'clojure', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', lua: 'lua', r: 'r', jl: 'julia', dart: 'dart', elm: 'elm', fs: 'fsharp', fsx: 'fsharp', ml: 'ocaml', pl: 'perl', pm: 'perl', gradle: 'gradle', groovy: 'groovy', vba: 'vba', bas: 'vba', cls: 'vba', graphql: 'graphql', gql: 'graphql', prisma: 'prisma', tf: 'terraform', tfvars: 'terraform', json: 'json', jsonl: 'jsonl', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', properties: 'properties', ini: 'ini', md: 'markdown', markdown: 'markdown',
    };
    return groups[ext] || 'other';
}
function findingLocation(finding) {
    const loc = finding?.location || {};
    return { path: loc.path || finding?.file || finding?.path || null, line: loc.startLine ?? finding?.line ?? null };
}

/** Summarizes analysis output separately from codebase-health claims. */
export function buildAnalysisMetrics({
    files = [], functions = [], classes = [], dependencies = [], callGraph = {}, findings = [],
    analysisCoverage = {}, healthScoreDetails = {}, apiEndpoints = [], databaseSchema = {},
    testLinkage = {}, findingDeduplication = null,
} = {}) {
    const languageStats = {};
    let totalBytes = 0;
    let physicalLines = 0;
    let nonBlankLines = 0;
    let commentOnlyLinesEstimated = 0;
    for (const file of files) {
        const content = String(file.content || '');
        const language = languageFor(file.path);
        const lines = content.split(/\r?\n/);
        const nonBlank = lines.filter((line) => line.trim()).length;
        totalBytes += typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(content).byteLength : content.length;
        physicalLines += lines.length;
        nonBlankLines += nonBlank;
        // Deliberately labelled as an estimate; not a language-aware comment parser.
        commentOnlyLinesEstimated += lines.filter((line) => /^\s*(?:\/\/|\/\*|\*|\*\/|#|<!--|--|REM\b|'''|""")/.test(line)).length;
        languageStats[language] ||= { files: 0, bytes: 0, physicalLines: 0, nonBlankLines: 0 };
        languageStats[language].files++;
        languageStats[language].bytes += typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(content).byteLength : content.length;
        languageStats[language].physicalLines += lines.length;
        languageStats[language].nonBlankLines += nonBlank;
    }
    const bySeverity = {};
    const byCategory = {};
    const byStatus = {};
    let evidenceAvailable = 0;
    let sourceLocated = 0;
    const fileHotspots = new Map();
    for (const finding of findings) {
        const severity = String(finding.severity || 'info').toLowerCase();
        const category = String(finding.category || 'unknown').toLowerCase();
        const status = String(finding.status || 'detected').toLowerCase();
        bySeverity[severity] = (bySeverity[severity] || 0) + 1;
        byCategory[category] = (byCategory[category] || 0) + 1;
        byStatus[status] = (byStatus[status] || 0) + 1;
        if (finding.evidenceAvailable || (Array.isArray(finding.evidence) && finding.evidence.length)) evidenceAvailable++;
        const loc = findingLocation(finding);
        if (loc.path && Number.isInteger(loc.line)) sourceLocated++;
        if (loc.path) fileHotspots.set(loc.path, (fileHotspots.get(loc.path) || 0) + 1);
    }
    const resolvedEdges = dependencies.filter((edge) => edge.resolution === 'resolved').length;
    const inferredEdges = dependencies.filter((edge) => edge.resolution === 'inferred').length;
    const ambiguousEdges = dependencies.filter((edge) => edge.resolution === 'ambiguous').length;
    const unresolvedEdges = dependencies.filter((edge) => edge.resolution === 'unresolved').length;
    const totalCallRefs = callGraph.diagnostics?.totalCallNameReferences || 0;
    const resolvedCallRefs = callGraph.diagnostics?.resolvedCallNameReferences || 0;
    const parserCoverage = analysisCoverage.parserCoverage || {};
    const astShare = parserCoverage.codeFiles ? pct(parserCoverage.astPreferredFiles || 0, parserCoverage.codeFiles) : null;
    const parserCoverageScore = analysisCoverage.status === 'complete' && (parserCoverage.heuristicParserFiles || 0) === 0 ? 'stronger-reported-coverage' : analysisCoverage.status === 'partial' ? 'limited-reported-coverage' : 'unknown-reported-coverage';
    const analysisQuality = {
        status: analysisCoverage.status || 'unknown',
        label: parserCoverageScore,
        astSharePct: astShare,
        evidenceAttachedPct: pct(evidenceAvailable, findings.length),
        sourceLocationPct: pct(sourceLocated, findings.length),
        dependencyResolutionPct: pct(resolvedEdges, dependencies.length),
        callReferenceResolutionPct: totalCallRefs ? pct(resolvedCallRefs, totalCallRefs) : null,
        caveats: [
            'These are observability/coverage indicators, not precision/recall or proof of semantic correctness.',
            'Resolution percentages measure observed references/edges, not the fraction of all real relationships that were found.',
            'Estimated comment-only lines are line-pattern estimates, not exact language-aware LOC metrics.',
        ],
    };
    return {
        schemaVersion: 1,
        semantics: 'Summary metrics describe what the engine represented in this run; they are not independent ground-truth validation.',
        repository: {
            files: files.length, functions: functions.length, classes: classes.length,
            dependencies: dependencies.length, dependencyResolution: { resolved: resolvedEdges, inferred: inferredEdges, ambiguous: ambiguousEdges, unresolved: unresolvedEdges },
            functionCallRelationships: (callGraph.functionConnections || []).length,
            apiEndpoints: apiEndpoints.length,
            databaseTables: (databaseSchema.tables || []).length,
            testFiles: testLinkage.testFileCount || 0,
            linkedTestFiles: testLinkage.linkedTestFileCount || 0,
        },
        sourceSize: {
            bytes: totalBytes, physicalLines, nonBlankLines, estimatedCommentOnlyLines: commentOnlyLinesEstimated,
            averagePhysicalLinesPerFile: files.length ? Math.round(physicalLines / files.length * 10) / 10 : 0,
            semantics: 'Physical/non-blank counts are exact over supplied strings; comment-only count is a conservative line-prefix estimate.',
        },
        languages: Object.fromEntries(Object.entries(languageStats).sort((a, b) => b[1].files - a[1].files)),
        findings: {
            total: findings.length, bySeverity, byCategory, byStatus,
            evidenceAvailable, evidenceAvailablePct: pct(evidenceAvailable, findings.length),
            sourceLocated, sourceLocatedPct: pct(sourceLocated, findings.length),
            deduplication: findingDeduplication ? { inputCount: findingDeduplication.inputCount, outputCount: findingDeduplication.outputCount, duplicatesMerged: findingDeduplication.duplicateCount } : null,
            hotspots: [...fileHotspots.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, 30),
        },
        analysisQuality,
        groundTruthValidation: { status: 'not-run', precision: null, recall: null, f1: null, reason: 'Ground-truth metrics require manually reviewed expected findings; they are not inferred from finding counts.' },
        healthScore: {
            score: healthScoreDetails.score ?? null,
            grade: healthScoreDetails.grade ?? null,
            kind: healthScoreDetails.kind || 'unknown',
            coverageStatus: analysisCoverage.status || 'unknown',
            mustReadAlongsideCoverage: true,
            semantics: 'The health score remains the existing heuristic score and is not an independent quality certification.',
        },
        actionPlan: buildFindingActionPlan(findings, 200),
    };
}
