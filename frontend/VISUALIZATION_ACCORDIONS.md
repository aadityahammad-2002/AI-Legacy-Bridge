# Visualization Explorer — collapsible sections

This update is based on `AI-Legacy-Bridge-Web-Workers-P0-P1-P2-Complete-Frontend.zip`, including Analysis Engine v8.2.5 and both previous Analysis Coverage / Potential Change Impact accordions.

## Changed areas

- Left sidebar: Repository Health, Color By, Repository Stats, Languages & LOC, and Explorer. Explorer starts **expanded**, so the file search and folder tree remain usable immediately. The Repository Health summary keeps the real score visible when collapsed.
- Left contextual panels: Related Tests and Potential Data Flows use the same accessible down-arrow behavior as Analysis Coverage and Potential Change Impact. Counters and caveats are preserved.
- Folder graph selection: the Files list collapses independently; the selected folder title stays visible, and file items still navigate to the dependency graph.
- Right File view: Impact Analysis collapses; the file name, source path, and View Source button stay visible. Connections and Functions retain their existing accordions.
- Right Actions view: each suggestion independently expands to reveal its complete description, recommended action, and benefit; Duplicate Functions gets a single group accordion. Issue, Pattern, and Security tabs remain normal tab views, with clickable details intact.

All new accordions use browser-native `<details>` and `<summary>`, including keyboard access via Enter/Space, visible focus rings, and reduced-motion styling. The graph toolbar, tabs, navigation, and resizable side panels are unchanged.

## Files

Replace the following files inside the existing project:

- `frontend/src/pages/VisualizationExplorer.jsx`
- `frontend/src/pages/VisualizationExplorer.css`
- `frontend/src/components/RepositoryPanel.jsx`
- `frontend/src/components/RepositoryPanel.css`

Add the following files:

- `frontend/tests/visualization-accordions.test.mjs`
- `frontend/VISUALIZATION_ACCORDIONS.md`

No Analysis Engine, worker, backend, API, or package-dependency modifications.

## Testing

```powershell
cd frontend
node --test tests/visualization-accordions.test.mjs tests/frontend-real-data.test.mjs tests/worker-dispatch.test.mjs tests/worker-optimization.test.mjs
npm run build
npm run dev
```

The included test is a *static source regression test*, not a complete React browser E2E test. The release also passed a standalone Chromium native-accordion interaction fixture; full Vite build / application browser E2E must run on the local machine with installed npm dependencies.
