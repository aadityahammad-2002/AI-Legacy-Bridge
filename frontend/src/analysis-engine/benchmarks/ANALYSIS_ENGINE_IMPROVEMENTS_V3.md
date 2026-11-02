# Analysis Engine Improvements — V3

## Scope

This pass is limited to `frontend/src/analysis-engine/` and its tests/benchmarks. No Java backend, Python AI service, or unrelated frontend screens were changed in this pass.

## Work included in the updated project

### Reliability and observable coverage
- Preserve analysis-stage/file-level failure information instead of silently translating failed complexity analysis into a low-risk score.
- Report parser strategy, language-level extraction coverage, unresolved local imports, ambiguous imports, call-graph resolution/attribution, and function-complexity coverage with explicit semantics.
- Treat files without applicable executable script and repositories with no discovered functions as `skipped` / `not-applicable`, not as zero-complexity or false 0% documentation coverage.

### Dependency resolution and graph quality
- Resolve TypeScript/JavaScript aliases, inherited `tsconfig` path mappings, `.js` import specifiers to available TS source, multiline/multiple imports, local re-export chains, workspace package exports and Python relative imports.
- Resolve `from . import module_a, module_b` as independent sibling-module candidates. If an imported name might instead be a package attribute re-exported by `__init__.py`, expose it as an unresolved package-member uncertainty rather than incorrectly treating the whole package as one ambiguous edge.
- Treat Java package wildcard imports as inferred candidate dependencies, instead of mislabelling one wildcard import with many valid package members as an ambiguous import.
- Mask Java comments and text blocks before extracting import-shaped text. Keep source lines in evidence.
- Add function-level direct/transitive caller impact with heuristic attribution explicitly labelled as heuristic.
- Avoid counting Java method declarations as call sites and ignore call-shaped decoys in comments, strings, and Java text blocks.

### Metrics, security signals, and cache
- Complexity excludes comment/string decoys and uses full function source spans where available rather than truncated display snippets.
- The bounded data-flow pass preserves template interpolation expressions, resets heuristic taint after a constant overwrite, and labels source-to-sink outputs as low-confidence signals rather than verified vulnerabilities.
- Keep per-file extraction/complexity cache and verify repeat analysis keeps graph shape stable. The synthetic-scale benchmark checks a 120-module chain.
- Include test-to-source linkage and coverage-aware reporting from the existing V2 work.

### Regression and dogfooding tools
- `run-regression.mjs`: dependency-free representative regression assertions including module aliases/re-exports, Python relative imports, Java wildcard/text-block false positives, call graph, function impact, complexity, config parsing, and data-flow decoys.
- `run-scale-regression.mjs`: generated 120-module chain for dependencies, function calls, complexity coverage and cache reuse.
- `run-self-analysis.mjs`: analyzes the analysis engine's own source and checks structural invariants.
- `run-project-corpus.mjs`: analyzes first-party frontend, Java backend and Python AI-service source plus CSS resources and TS config manifests; reports per-language coverage and resolution diagnostics. This is useful dogfooding, not a manually verified accuracy benchmark.

## Latest validation results

All listed benchmark scripts and JS/MJS/CJS syntax checks passed in the current environment.

| Check | Observed result |
|---|---|
| Syntax checks for files under `frontend/src/analysis-engine` | Passed |
| Regression fixtures | 14 files; 6/6 expected dependency edges found; 4 resolved file-call edges; 5 function-call edges; direct and transitive callers found |
| Synthetic scale | 120 modules; 119/119 expected dependency edges; 119/119 function-call edges; 120 extraction and 120 complexity cache hits on repeat |
| Engine self-analysis | 20 source files; 206 functions; 23 dependency edges; 0 unresolved local imports; 0 ambiguous imports |
| First-party project corpus | 121 inputs; 717 extracted functions; 37 classes; 205 dependency edges (144 resolved, 61 inferred); 0 unresolved local imports; 0 unresolved package members; 0 ambiguous imports; 760 function-call edges |

The first-party corpus reported `partial` overall coverage because extraction is heuristic in this Node benchmark runtime and the engine intentionally labels incomplete semantic certainty. A zero unresolved-import count for this one corpus is not evidence of universal parser correctness.

## Validation not completed

- The full Vitest unit suite could not run because `frontend/node_modules/.bin/vitest` is missing in the current environment.
- The Vite production build was not run.
- These results do not replace compiler/type-checker validation, real repository ground-truth reviews, Java/Python service tests, or PostgreSQL integration testing.
- The heuristic data-flow scanner is not a complete taint analyzer: it does not prove exploitability or safety, fully model scopes/control flow, or follow data interprocedurally.
- Function-level change impact, same-package class usage, and fallback parsing remain heuristic. Their confidence labels and coverage diagnostics must not be presented as calibrated probabilities.
