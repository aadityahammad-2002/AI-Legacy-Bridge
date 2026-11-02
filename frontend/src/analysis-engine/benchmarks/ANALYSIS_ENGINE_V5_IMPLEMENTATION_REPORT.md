# AI Legacy Bridge — Analysis Engine V5 Implementation Report

## Scope and baseline

V5 is built on the V4 archive. Code changes are limited to `frontend/src/analysis-engine/` plus this report/README. Backend, RAG, authentication, and unrelated product UI are unchanged. The manually verified real-repository benchmark remains deliberately deferred to the final validation phase requested by the project owner.

## Added and integrated in V5

### 1. Unified analysis model and reusable graph operations

- `unifiedAnalysisModel.js` normalizes files, extracted functions/classes, dependency edges, function calls, endpoints, database tables, test links, and findings into a serializable entity/edge model.
- Relationship metadata preserves resolution, confidence, source line, evidence, and resolution method where available; heuristic relationships are not promoted to confirmed facts.
- Stable content-derived identifiers (FNV-1a, not cryptographic) enable predictable entity/finding identities.
- `queryAnalysisModel` supports bounded entity and relation queries.
- `sliceAnalysisModel` supports forward/reverse/bidirectional bounded graph slices with depth, node, and relation-type limits.
- `compareAnalysisResults` classifies findings as new/persisting/resolved-or-not-reproduced and compares represented dependency/call edges, API endpoints, and database tables across snapshots.

### 2. Custom policy rules and reviewable suppressions

- `ruleEngine.js` loads `.analysis-engine-rules.json` or `analysis-rules.json` with bounded counts/pattern lengths and line-based candidate matching.
- Basic ReDoS-oriented guards reject backreferences, lookarounds, nested quantifiers, and repeated dot-wildcards. This is a heuristic guard, not a proof of regex safety.
- `analysis-suppressions.json` can suppress by rule ID, path, and/or line. Suppressed findings remain in output with reason and `status: "suppressed"`.

### 3. Additional bounded analyses

- Event publisher/subscriber matching by explicit string event names.
- Local exception-flow summaries for `throw`/`raise` and `catch`/`except` syntax.
- Resource lifecycle hints for acquisition/release and cleanup constructs.
- Explicit begin/commit/rollback balance hints.
- Simple opposite-boolean-guard candidates for path-feasibility review.
- API endpoint collisions after normalizing common path parameter shapes.
- Source-local authorization-signal checks and data-flow signals exposed as security-invariant review hints.
- Bounded token-shingle near-clone candidates.
- Call/dependency graph structural consistency checks.
- Conservative reachability candidates from heuristic entry points over resolved call edges.
- Dependency-based risk propagation for prioritization (not vulnerability reachability proof).
- State-assignment inventories, concurrency syntax/mutable-state hints, generated-code/vendor candidates, and finding-cluster candidates.
- Resource and analysis-count caps with per-pass limitations and partial statuses.

### 4. Export and integration

- `reportFormats.js` exposes `toSarifLog(result)` (SARIF 2.1.0) and `toAnalysisJson(result)`.
- The orchestrator integrates the passes, adds coverage fields, appends normalized candidate findings, and exports query/slicing/diff/rule helpers.
- README includes integration examples and the custom-rule/suppression formats.

## Validation in this environment

The following were run from the extracted V5 workspace:

- `node --check` for top-level analysis-engine `.js` modules — passed after fixes.
- `benchmarks/run-regression.mjs` — passed against the existing V4 14-file regression fixture set (6/6 expected dependency edges; other existing graph, metrics, route, and data-flow assertions passed).
- `benchmarks/run-v5-regression.mjs` — passed: custom rule load/match, event flow, resource-cleanup candidate, unbalanced transaction candidate, normalized route collision, unsupported language visibility, unified model query/slice, route/table/finding diff, suppression labeling, SARIF export, and orchestrator integration.

Full browser Vitest/build tests were not run because this environment's extracted project did not have `frontend/node_modules` installed. The owner plans to run the local application and full checks. The final real-repository benchmark has not been run by design.

## Important limitations (not claimed as solved)

V5 extends practical heuristic analysis. It is not a compiler-grade semantic analyzer for all languages. Full CFG/SSA construction, general points-to/alias analysis, broadly path-sensitive interprocedural dataflow, complete exception propagation, dynamic/reflection resolution, real runtime trace/coverage ingestion, and cross-language symbol/type checking remain incomplete.

General symbolic execution, formal model checking, universal loop-termination proofs, and proof-grade security invariants are not implemented. Event-name linking, resource/transaction lifecycle checks, path-condition candidates, route collisions, semantic clones, concurrency signals, and reachability are review leads; false positives/negatives are expected. A clean report does not prove that code is safe.

Results from synthetic fixtures and self-analysis establish integration/invariants, not precision/recall for arbitrary codebases. The final manually verified repository benchmark remains a required release gate.
