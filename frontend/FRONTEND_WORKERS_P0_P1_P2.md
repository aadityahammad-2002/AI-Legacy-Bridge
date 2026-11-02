# AI Legacy Bridge — Frontend Worker Execution Upgrade

Scope: Frontend execution and responsiveness only. **Analysis Engine v8.2.5 is unmodified**. Repository ingest contracts, source file content, UI routes, graph nodes/edges, and existing page features are preserved.

## P0: heavy computations off the React main thread
- `src/workers/analysis.worker.js`: full existing `analyzeRepository` call, initializes Acorn+Babel within Worker. `UploadPage` receives original progress and output. Worker terminates after completion; unmount aborts stale work.
- `src/workers/graph.worker.js`: Dependency Graph force tick calculations; Galaxy forces for both standard and immersive views, while SVG rendering and zoom stay on the UI thread.
- `src/workers/cluster.worker.js`: live Cluster-mode force simulation, worker messages stream actual coordinates; drag sends fixed coordinates to Worker.

## P1: larger repository operations
- `src/workers/zip.worker.js` + `src/repo-sources/zipCore.js`: decompress, inspect and decode ZIP sources off-thread. The original entry-size, total-size, candidate-count, unsafe path, file-type, and warning checks are preserved verbatim.
- `src/workers/migration.worker.js`: real heuristic migration scan off-thread, no fake findings or simulated delays.
- `src/workers/graphOps.worker.js`: for repositories with >=1500 dependency edges, compute folder dependency graph and bounded change-impact traversal off-thread; for >=1500 files, search paths off-thread with short debounce. Smaller inputs remain synchronous for lower overhead.

## P2: conditional/off-thread utilities
- `src/workers/json.worker.js`: large ingest payload JSON.stringify, report/raw-JSON export serialization. The source-code-containing ingest JSON is not stripped.
- `src/workers/export.worker.js`: analysis download preparation when repository has >=75 files. The existing export contract is unchanged.
- Lightweight matrix/treemap/radial operations remain on the main thread intentionally because those views already impose small display caps and/or their calculations are cheaper than Worker setup + transfers. SVG/PDF DOM serialization must remain on the main thread.

## Safety and compatibility
- Workers are Vite `?worker` module imports, not raw script URLs; browser data stays local to the current origin.
- Worker errors surface to console; visualization workers can fall back to previous layout behavior. Analysis Worker errors fail visibly rather than hiding a silent main-thread retry.
- Short-lived workers terminate promptly. Live Cluster worker terminates when view unmounts. Stale graph/migration jobs use AbortController.
- No benchmarked latency improvements are claimed until browser-level timings are measured on the user's machine. Large structured-clone messages can increase peak memory; monitor Chrome Task Manager on 8 GB systems.

## Install
Extract the *Patch ZIP* at the project root (`AI-Legacy-Bridge-main/`), and choose **Replace files in destination**. Do not delete existing directories. Alternatively, use the complete frontend ZIP to replace `frontend/` after backing up custom changes.

```powershell
cd frontend
npm ci
npm run build
node --test tests/worker-optimization.test.mjs tests/worker-dispatch.test.mjs
npm test
npm run dev
```

Recommended validation on four real repositories: re-run analysis and compare *meaningful* symbol/API/dependency/graph contents with baseline (exclude generated timestamps and cache diagnostics). Exercise force, galaxy, cluster drag, ZIP, migration, export, and repository navigation while analyzing. Browser build and interaction tests could not be executed in this environment because dependencies were unavailable.
