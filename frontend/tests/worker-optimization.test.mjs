import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../src/workers/workerClient.js';
import { scanRepository } from '../src/workers/migrationScan.js';
import { buildFolderGraph, selectVisibleGraphNodes } from '../src/components/graphData.js';
import { computeChangeImpact } from '../src/analysis-engine/changeImpact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // resolved relative to tests
// Optional real-corpus test; supply ANALYSIS_CORPUS_DIR with the four exported JSON files.
const DATA = process.env.ANALYSIS_CORPUS_DIR || '/mnt/data';
const REAL = [
  'HRMS--Human-Resource-Managment-System-analysis (2).json',
  'CultivationX---localDev-analysis (2).json',
  'AUTH-RBAC-System-analysis (2).json',
  'AI-Legacy-Bridge-main-analysis (4).json',
];

test('worker RPC: progress, results, structured errors, abort, termination', async () => {
  const Original = globalThis.Worker;
  let workers = [];
  class MockWorker {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(payload) {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onmessage?.({ data: { type: 'progress', progress: { phase: 'extracting', current: 1, total: 2 } } });
        this.onmessage?.({ data: payload?.fail
          ? { type: 'error', name: 'TypeError', message: 'deliberate' }
          : { type: 'result', result: payload } });
      });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = MockWorker;
  try {
    const events = [];
    const result = await runWorker(new URL('file:///fake.worker.js'), { ok: 1 }, { onProgress: (p) => events.push(p.phase) });
    assert.deepEqual(result, { ok: 1 });
    assert.deepEqual(events, ['extracting']);
    assert.equal(workers.at(-1).terminated, true);
    await assert.rejects(() => runWorker(new URL('file:///fake.worker.js'), { fail: true }), /deliberate/);
    assert.equal(workers.at(-1).terminated, true);
    const abort = new AbortController();
    const running = runWorker(new URL('file:///fake.worker.js'), { ok: 2 }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(workers.at(-1).terminated, true);
  } finally { globalThis.Worker = Original; }
});

test('migration heuristics use only actual source evidence and stable shape', () => {
  const files = [
    { path: 'a.js', content: 'const api_key = "plain";\nvar x = 1;\neval(input);' },
    { path: 'requirements.txt', content: 'requests==2.1.0' },
    { path: 'clean.py', content: 'def f():\n    return 1' },
  ];
  const hits = scanRepository(files);
  assert.equal(hits.length, 4);
  assert.deepEqual(hits.map((x) => x.filePath), ['a.js','a.js','a.js','requirements.txt']);
  assert.ok(hits.every((x) => x.source === 'heuristic' && Number.isInteger(x.line)));
  assert.equal(scanRepository([{ path: 'clean.py', content: 'pass' }]).length, 0);
});

test('four real exported repositories: graph edges grounded in existing files', { skip: REAL.some((name) => !fs.existsSync(path.join(DATA, name))) }, () => {
  const totals = [];
  for (const filename of REAL) {
    const obj = JSON.parse(fs.readFileSync(path.join(DATA, filename), 'utf8'));
    const analysis = obj.analysis;
    assert.equal(analysis.engineVersion, '8.2.5');
    const folder = buildFolderGraph(analysis.files, analysis.dependencies || []);
    const folderIds = new Set(folder.nodes.map((n) => n.id));
    assert.ok(folder.nodes.length > 0);
    assert.ok(folder.edges.every((e) => folderIds.has(e.source) && folderIds.has(e.target)));
    assert.ok(analysis.files.every((f) => typeof f.path === 'string'));
    const selected = analysis.files[0]?.path;
    if (selected) {
      const impacted = computeChangeImpact(selected, analysis.dependencies || [], { coverageStatus: 'partial' });
      assert.equal(impacted.changedPath, selected);
      assert.ok(!impacted.affectedFiles.some((f) => f.path === selected));
      const realPaths = new Set(analysis.files.map((f) => f.path));
      assert.ok(impacted.affectedFiles.every((f) => realPaths.has(f.path)));
    }
    totals.push({ repository: obj.repository.name, files: analysis.files.length, folderNodes: folder.nodes.length, folderEdges: folder.edges.length });
  }
  console.log(JSON.stringify(totals));
});

test('400-node view is bounded and selected-node neighborhood stays in view', () => {
  const nodes = Array.from({ length: 550 }, (_, i) => ({ id: `src/f${i}.js` }));
  const edges = [{ source: nodes[548].id, target: nodes[549].id }];
  const visible = selectVisibleGraphNodes(nodes, edges, nodes[549].id, 400);
  assert.equal(visible.length, 400);
  assert.equal(visible[0].id, nodes[549].id);
  assert.ok(visible.some((node) => node.id === nodes[548].id));
});
