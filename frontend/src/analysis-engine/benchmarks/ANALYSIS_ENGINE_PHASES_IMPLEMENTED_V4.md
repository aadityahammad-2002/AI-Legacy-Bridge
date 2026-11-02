# AI Legacy Bridge — Analysis Engine V4 Implementation Report

## Scope

This pass builds on the V3 project and targets the remaining analysis-engine phases only. Code changes in this pass are confined to `frontend/src/analysis-engine/` (engine modules plus regression/benchmark scripts and fixtures). The manually verified real-repository benchmark has deliberately **not** been run; the owner asked to keep that as the final validation phase. Full local application tests/build are also left for the owner's local run.

## Implemented in this pass

### 1. Symbol and call-graph resolution
- Count call-site argument arity for explicit receivers and use it as a conservative overload disambiguator.
- Resolve explicit same-class receivers, typed receiver calls backed by explicit type evidence, and uniquely resolvable direct-super calls.
- Follow unique single-inheritance chains when a method is inherited from an ancestor, and support Python's conventional `super().method()` form.
- Keep ambiguous overloads, unresolved dynamic dispatch, and Python multiple-inheritance/MRO cases unresolved rather than guessing.
- Preserve source lines, call excerpts, receiver data, argument count, and resolution reasoning on emitted edges.

### 2. Module-resolution coverage
- Keep the existing V3 support for TypeScript path mappings, `.js`-specifier-to-TypeScript source substitutions, re-export aliases, Python relative imports, Java wildcard candidates, Node workspace package `exports`, package-local `imports` maps, and bounded parsed-import caching.
- Add regression cases for workspace package export maps and package-local `#imports` maps.

### 3. Maintainability metrics
- Improve estimated control-flow nesting so JavaScript object-literal braces do not inflate nesting depth.
- Use the Python function's declaration indentation as the baseline so the method's own indentation is not counted as nested control flow.
- Retain explicit low-confidence/heuristic semantics for complexity and cognitive-complexity estimates.
- Preserve tests for full function spans, comment/string masking and single-parameter arrow functions.

### 4. Data-flow coverage and bounded interprocedural leads
- Add `.mts` and `.cts` to the explicitly supported JS/TS heuristic data-flow extensions.
- Enumerate other recognized source-file extensions not covered by the data-flow rules, report `coverage.supportedFiles`, `coverage.unsupportedFiles`, supported/unsupported extension lists, and mark the data-flow stage `partial` when relevant source files are unsupported.
- Retain bounded source-to-sink scanning and interprocedural propagation through uniquely resolved call edges. Findings remain low-confidence investigation leads, not proof of vulnerability or safety.

### 5. Framework and test linkage
- Combine a Spring controller's class-level `@RequestMapping` base path with the method-level route path, without emitting the class annotation as a separate endpoint.
- Keep route-to-handler linkage source-based and explicitly inferred, not runtime-verified.
- Add regression checks for a route-linked handler and production functions linked from tests through resolved call edges.

### 6. Incremental invalidation and bounded performance checks
- Extend the synthetic scale benchmark to edit a source file and verify that its extraction/complexity cache entries miss and old dependency/call edges disappear.
- Extend the same benchmark to remove a module and verify that the active graph does not retain edges to the removed file.
- Repository-level dependency and call graphs are still recomputed against the current file snapshot to avoid stale graph state; the cache currently accelerates deterministic per-file extraction and complexity, not every graph stage.

## Validation run in this environment

- `node --check` passed for all **39 JavaScript/MJS files** under the analysis-engine directory.
- `run-regression.mjs`: **passed** against 14 fixture files; 6 expected dependency edges were present (6 observed). Additional checks passed for package maps, Python `super()`, direct/transitive superclass chains, receiver overload arity, typed receivers, control-flow nesting, data-flow coverage, Spring route paths, test-to-source links, cache reuse and other existing regression cases.
- `run-scale-regression.mjs`: **passed** for 120 synthetic modules: 119/119 expected resolved dependencies and 119/119 expected function call edges. Second run reported 120 extraction-cache hits and 120 complexity-cache hits. A content edit produced one extraction miss and one complexity miss and removed the stale outgoing edges; removing a module did not leave a stale graph target.
- `run-self-analysis.mjs`: **passed** its invariants on the analysis-engine source: 22 source files, 258 extracted functions, 28 dependency edges, 28 resolved edges, zero unresolved local imports and zero ambiguous imports in this self-analysis run.

Self-analysis and synthetic fixtures verify integration/invariants, not semantic correctness for arbitrary real repositories. No manually verified repository benchmark was run in this pass, by design. Full frontend Vitest/build verification is left for the owner's local validation.

## Remaining limitations (not silently claimed as solved)

- These are pragmatic static-analysis heuristics, not a language server/compiler-grade semantic model for every supported language.
- Reflection, runtime/dynamic imports, generated code, unresolved overloads, Java/Kotlin dispatch, Python multiple-inheritance MRO, and framework runtime registration may remain unresolved or inferred.
- Data-flow analysis does not model full control flow, aliasing, types, sanitizers' semantic effectiveness, or all interprocedural paths. A finding is not proof of exploitability; no finding is not proof of safety.
- Maintainability/cognitive-complexity scores are descriptive estimates, not calibrated quality ratings.
- Test linkage does not prove that a test executes, passes, or asserts behavior.
- Whole-repository ground truth, false-positive/false-negative rates, and large real-world repository performance still need the explicitly deferred manually verified benchmark and local application checks.
