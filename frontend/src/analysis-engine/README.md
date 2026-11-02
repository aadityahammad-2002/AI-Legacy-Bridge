# Analysis Engine v8.2.5

Browser-side analysis engine over an in-memory `[{ path, content }]` source snapshot. The engine returns structured facts, evidence, coverage diagnostics and heuristic candidates. Absence of a finding is not proof of safety or correctness.

## Main entry point

```js
import {
  configureAnalysisEngine,
  analyzeRepository,
  queryAnalysisModel,
  sliceAnalysisModel,
  compareAnalysisResults,
  prepareRepositoryFiles,
  compareFileSnapshots,
  buildIncrementalAnalysisPlan,
  toSarifLog,
  toAnalysisJson,
} from './analysis-engine/orchestrator.js';

configureAnalysisEngine({ acorn, Babel });
const result = await analyzeRepository({ name: 'repo', source: 'local' }, files, progressCallback, {
  maxFiles: 10000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxPathDepth: 80,
  excludeDefaultDirectories: true,
  excludeGenerated: true,
  excludePaths: ['fixtures/large-data/', 'vendor-copy/'],
  includeExtensions: ['.js', '.ts', '.py', '.java'],
  previousResult, // optional prior result for a diff/impact plan; not an incremental execution switch
});

const query = queryAnalysisModel(result.analysisModel, { entityKind: 'function', name: 'create' });
const slice = sliceAnalysisModel(result.analysisModel, { path: 'src/service.ts', direction: 'both', maxDepth: 3 });
const diff = compareAnalysisResults(previousResult, result);
const sarif = toSarifLog(result); // SARIF 2.1.0
const json = toAnalysisJson(result);
```

## Input policy and coverage

`prepareRepositoryFiles(files, options)` canonicalizes repository-relative paths, enforces resource bounds, filters configured directories/generated file patterns and reports `skippedFiles` plus `excludedByReason`. Default excluded folders include common VCS, dependency, build, cache and virtual-environment directories. Default generated patterns include common minified/bundled/generated suffixes. Set `excludeDefaultDirectories: false` or `excludeGenerated: false` to change those defaults; custom `excludePaths` and `includeExtensions` can narrow a scan further.

Unsafe absolute/traversal paths and normalized duplicate paths throw before analysis. Over-limit files, binary/control-heavy files, and policy-excluded inputs are skipped with an explicit reason. The result's `analysisInput` includes supplied/included/excluded counts; `analysisCoverage.inputPreparation` summarizes the omissions and forces coverage to `partial` when any files were excluded. Review `skippedFiles` before interpreting results as a full repository scan.

## New V6 output

- `engineVersion`: shared `6.0.3` version used by result, source snapshot and SARIF.
- Call-graph attribution: counts resolved call-site units consistently, reports unresolved/unattributed sites separately, and does not confuse bounded edge samples with total metrics.
- `reportComparison.js`: normalizes exports and compares multi-version reports per repository without requiring source code.
- `findingDeduplication`: exact duplicate groups and their counts. Findings with different messages, rule IDs or locations are not merged by default.
- Stable `finding.id`: derived from rule, path, line range, title and message; IDs do not rely on array ordering. Fingerprints are non-cryptographic identity aids only.
- `dependencyUsage`: static import/manifest linkage. An unreferenced declared package is a low-confidence candidate, not proof it is unused. JVM dependency artifact-to-import mapping is not guessed because names often differ.
- `analysisMetrics`: source-size/language summaries, represented dependency and call graph counts, findings by severity/category/status, evidence/location rates, file hotspots and a conservative action plan.
- `incrementalAnalysis`: optional comparison against `options.previousResult` with changed file list and estimated affected dependents. It explicitly reports `incrementalExecutionImplemented: false`; repository-wide graphs are still recomputed, though per-file extraction/complexity caches may be reused.
- `apiContractAnalysis`: compares supported static frontend HTTP calls with discovered backend route/method pairs; mismatch findings are included in `findings`. It is heuristic and may miss proxy or dynamically constructed routes.
- `healthScoreDetails.calibration`: remains `not-benchmarked` until manually reviewed score labels are supplied. The labelled benchmark reports MAE/RMSE/bias but does not automatically tune the score formula.
- `analysisCoverage.inputPreparation`, `.dependencyUsage`, and `.callGraph`: records coverage and interpretation limitations.
- Markdown architecture report sections for evidence quality, candidate unused dependencies, diff/impact plans and review actions.

## Existing analysis modules

- `parser.js`: symbol extraction and quality metrics; AST use depends on provided Acorn/Babel runtimes; other languages include heuristic strategies.
- `moduleResolution.js`, `callGraph.js`, `dataFlow.js`: dependency/call graph inference and bounded source-to-sink leads.
- `architecture.js`, `frameworkAnalysis.js`, `api.js`, `db.js`: architecture roles/boundaries, framework route signals, API endpoint and database schema candidates.
- `functionMetrics.js`, `quality.js`, `insights.js`: complexity/maintainability, TODO/docs/naming/config/a11y heuristics and prioritization.
- `testLinkage.js`: probable test-to-source relationships. This is not test coverage or evidence tests pass.
- `changeImpact.js`: conservative reverse-dependency and caller impact estimates.
- `advancedAnalysis.js`: bounded event-flow, exception/resource/transaction, route collision, reachability and graph-consistency candidates.
- `unifiedAnalysisModel.js`: normalized graph model, queries/slices and result diffs.
- `ruleEngine.js`: repository-local custom rules and reviewable suppressions.
- `reportFormats.js`: JSON and SARIF 2.1.0 output.

## Regression checks

```sh
npm run test:all
```

This runs dependency-light graph/quality regression fixtures, including source-inferred call attribution and naming/API-contract cases, 16 labeled static-analysis examples, synthetic scale/cache checks, source self-analysis, input/finding/dependency/diff/report checks, and 50/200/500-file runtime/heap/RSS profiles. Timings are informational and machine-specific. The full Vitest suite requires installing the development dependencies via `npm install`.

To evaluate real precision/recall, create manually reviewed expected findings and run:

```sh
npm run benchmark:labelled -- path/to/ground-truth.json
```

Do not treat the included example label as a real benchmark; real-repository labels must be reviewed by a person.

## What is still not claimed

The engine is not a compiler-grade verifier. General control-flow/SSA, comprehensive alias/points-to analysis, universal interprocedural path-sensitive data flow, symbolic execution/model checking, runtime traces/coverage ingestion and safe automated patches are not implemented here. Heuristic routes, dead-code candidates, dependency usage, source-to-sink leads and impact paths require review. The included synthetic fixtures test expected behavior for a small known set; manually labeled real-repository precision/recall and performance benchmarks remain release gates.


## v8.2.5 installation note

The downloadable JSON button lives in `frontend/src/pages/WorkspaceSelectionPage.jsx`,
not inside the analysis engine folder. The complete installation ZIP replaces that
one page and the analysis engine together. The engine-only ZIP deliberately does
not update the page. The download uses `toDownloadableAnalysisJson` from
`reportFormats.js` to exclude raw `fileContents` and `analysis.files[].content`.
See `HARDENING_v8.2.5.txt` for the targeted method-span fix.
