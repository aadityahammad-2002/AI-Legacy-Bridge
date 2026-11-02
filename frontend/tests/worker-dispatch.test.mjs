import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function mockD3() {
    const scalar = () => ({ strength() { return this; }, id() { return this; }, distance() { return this; } });
    return {
        forceSimulation(nodes) {
            return {
                force() { return this; }, stop() { return this; },
                tick() { nodes.forEach((n) => { n.x = (n.x ?? 0) + 1; n.y = (n.y ?? 0) + 1; }); return this; },
            };
        },
        forceLink: scalar, forceManyBody: scalar, forceCenter: scalar,
        forceCollide: scalar, forceX: scalar, forceY: scalar,
    };
}

function loadWorker(relativePath, globals = {}) {
    let source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    const posted = [];
    const scope = { self: { postMessage: (m) => posted.push(m) },
        reportWorkerError: (error) => posted.push({ type: 'error', message: error.message }),
        ...globals };
    vm.runInNewContext(source, scope, { filename: relativePath });
    return { scope, posted };
}

test('P0 graph force Worker honors force-tick count, returns source-backed node identities', () => {
    const { scope, posted } = loadWorker('../src/workers/graph.worker.js', { d3: mockD3() });
    const nodes = [{ id: 'a.js' }, { id: 'b.js' }];
    scope.self.onmessage({ data: { mode: 'force', nodes, edges: [{ source: 'a.js', target: 'b.js' }], width: 100, height: 100, spread: 0.5, linksParam: 0.5 } });
    assert.equal(posted.at(-1).type, 'result');
    assert.deepEqual(Array.from(posted.at(-1).result, (entry) => entry[0]), ['a.js','b.js']);
    assert.equal(posted.at(-1).result[0][1].x, 120); // min-tick lower bound of existing GraphCanvas
    assert.equal(nodes[0].x, undefined); // original objects not mutated by force
});

test('P0 Galaxy Worker preserves nodes and uses 180 ticks as original renderer', () => {
    const { scope, posted } = loadWorker('../src/workers/graph.worker.js', { d3: mockD3() });
    scope.self.onmessage({ data: { mode: 'galaxy', nodes: [{ id:'src/a.js' },{ id:'src/b.js' }],
        files: [{ path:'src/a.js' },{ path:'src/b.js' }], edges:[{ source:'src/a.js',target:'src/b.js' }],
        size: { width:600,height:500 } } });
    assert.equal(posted.at(-1).type, 'result');
    assert.equal(posted.at(-1).result.length, 2);
    assert.equal(posted.at(-1).result[1][1].x, 180);
});

test('P2 JSON Worker serializes without dropping nested source contents', () => {
    const { scope, posted } = loadWorker('../src/workers/json.worker.js');
    const payload = { repositoryId:'r1', files: [{ path: 'a.js', content:'const a = 1;' }] };
    scope.self.onmessage({ data: { mode:'serialize', payload } });
    assert.equal(posted.at(-1).type, 'result');
    assert.deepEqual(JSON.parse(posted.at(-1).result), payload);
    scope.self.onmessage({ data: { mode:'parse', json:posted.at(-1).result } });
    assert.equal(posted.at(-1).result.files[0].content, 'const a = 1;');
});
