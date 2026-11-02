# Analysis engine regression benchmarks

Run from the standalone package root:

```sh
node analysis-engine/benchmarks/run-regression.mjs
node analysis-engine/benchmarks/run-v5-regression.mjs
node analysis-engine/benchmarks/run-security-accuracy.mjs
node analysis-engine/benchmarks/run-scale-regression.mjs
node analysis-engine/benchmarks/run-self-analysis.mjs
```

- `run-regression.mjs` is a dependency-free correctness smoke gate for representative fixture repositories. It checks imports/re-exports, module aliases, Java same-package inference, Python relative imports, file and function impact, parser fallback spans, complexity false positives, accessibility/TODO/config scan comment false positives, stale-taint reset, and cache hits.
- `run-v5-regression.mjs` checks V5 unified-model contracts, custom rules/suppressions, snapshots, SARIF/JSON exports, and selected advanced-analysis candidates.
- `run-security-accuracy.mjs` uses 16 labelled synthetic positive/negative cases to prevent known security-scanner regressions. Its precision/recall numbers apply only to this small fixture set, not arbitrary real repositories.
- `run-scale-regression.mjs` generates a configurable chain of TypeScript-like modules (default 120; set `ANALYSIS_BENCH_MODULES=250` to change the count). It checks dependency/call edges, function complexity coverage, cache reuse, content-change invalidation, and file-removal invalidation.
- `run-self-analysis.mjs` analyzes the engine source itself as a dogfooding integration check. It verifies report invariants and surfaces unresolved references, but it does not know the complete ground-truth graph for the codebase.

These scripts complement Vitest. They are not language-conformance suites, not a real-world security accuracy study, and not proof of compiler-grade semantic correctness for arbitrary repositories. Timings depend on the environment and are not a performance SLA.
