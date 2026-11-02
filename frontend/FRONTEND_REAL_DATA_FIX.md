# AI Legacy Bridge — Frontend real-data correction

This update is **frontend-only** and includes the existing **Analysis Engine v8.2.5** unchanged.

## Changes

- Visualization Explorer: uses actual graph and dependency records, defaults to the standard dependency graph, avoids unresolved external folder nodes, prioritizes the selected node in large (>400 node) graphs, shows an explicit performance-limit notice, and falls back gracefully on graph-render exceptions.
- Left and right panels: sidebar scrolling and file-search expansion; folder mode cannot accidentally render a file-layout visualization; graph-only zoom controls are disabled for layouts that do not expose those controls.
- Test page: removed deterministic fake pass/fail/coverage/flaky metrics, invented QA scenarios and timestamps, mock generated tests, and simulated 200 API responses. Displays extracted functions, real test-linkage evidence, real discovered route declarations and optional safe GET backend connectivity check. AI test generation uses only the real service. No untrusted code execution occurs in the browser.
- AI Explorer: file viewer reconstructs content from the existing `files[].content` data if a separate `fileContents` mapping is absent. Persona sidebars show actual analysis counts instead of fictional completed checklists.
- Migrate: the repository scan runs against real source, without an artificial loading timer; outcomes remain explicitly classified as heuristics or LLM suggestions.
- Settings: removed invented onboarding/autonomy metrics. Team/profile values are clearly labeled browser-local and **do not grant permissions**. Connection settings display actual configured endpoint addresses, with an optional real backend availability check; the screen does not collect plaintext API secrets or pretend that saving validates credentials.
- Settings navigation: clicking a different workspace tab closes the Settings overlay correctly.

## Installation

**Patch ZIP:** Extract from your project root so paths land under `frontend/src/...`; back up existing changed files first. The ZIP does not contain or replace the backend or AI service.

**Full frontend source ZIP:** Extract from the project root; it contains the frontend source and v8.2.5 engine but omits `node_modules` and any `.env` secrets.

For Windows PowerShell:

```powershell
cd .\frontend
npm ci
npm run build
node --test tests/frontend-real-data.test.mjs
npm test
npm run dev
```

## Important data-contract notes

- The **backend ingest** continues to receive the existing complete analyzer result, including source content. The analysis engine, backend and existing JSON serialization were not modified by this frontend update.
- Detected API routes are repository source evidence; they are not automatically tested live. A safe check of *AI Legacy Bridge's own backend* is available separately.
- Test pass/fail and measured runtime coverage are shown as unavailable rather than guessed because there is no integrated repository test runner in the provided frontend/backend contract.
- Local team entries are not IAM or access controls; authoritative access management requires server-side support.
- Visualization force simulation positions are a layout technique: actual graph nodes and edges still come from the analyzer. Large graphs use a visible 400-node render limit, without altering source data.

## Verification completed

- `node --test tests/frontend-real-data.test.mjs`: 5/5 passing.
- Folder-graph projection checked against four actual v8.2.5 analysis exports (HRMS, CultivationX, AUTH-RBAC, AI Legacy Bridge): zero dangling folder edges.
- **Not run:** Vite build, Vitest or browser end-to-end tests. Dependencies could not be installed in the current offline environment. Run the commands above in your project environment to validate those paths.
