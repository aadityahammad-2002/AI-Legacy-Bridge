import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFolderGraph, selectVisibleGraphNodes } from '../src/components/graphData.js';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('Folder graph only contains real folders and resolved repo paths', () => {
    const files = [{ path: 'src/Controller.java' }, { path: 'src/lib/Service.java' }, { path: 'test/Service.test.java' }];
    const dependencies = [
        { source: 'src/Controller.java', target: 'src/lib/Service.java' },
        { source: 'src/Controller.java', target: 'external/NotInRepository.java' },
        { source: 'src/Controller.java', target: 'test/Service.test.java' },
        { source: 'src/Controller.java', target: 'test/Service.test.java' },
    ];
    const result = buildFolderGraph(files, dependencies);
    assert.equal(result.nodes.length, 3);
    assert.deepEqual(result.edges, [{ source: 'src', target: 'src/lib' }, { source: 'src', target: 'test' }]);
});

test('Selected node remains visible beyond 400 node cap, neighbors included', () => {
    const nodes = Array.from({ length: 700 }, (_, i) => ({ id: `node-${i}` }));
    const edges = [{ source: 'node-699', target: 'node-501' }];
    const selected = selectVisibleGraphNodes(nodes, edges, 'node-699', 400);
    assert.equal(selected.length, 400);
    assert.equal(selected[0].id, 'node-699');
    assert.equal(selected[1].id, 'node-501');
    assert.equal(new Set(selected.map((n) => n.id)).size, 400);
    assert.equal(selectVisibleGraphNodes(nodes, edges, null, 400).length, 400);
});

test('Unit test UI never invents execution result or coverage data', () => {
    const page = source('pages/TestsPage.jsx');
    assert.doesNotMatch(page, /buildMockTests|INITIAL_FEATURE_GROUPS|setTimeout\(/i);
    assert.match(page, /analysisResult\?\.testLinkage/);
    assert.match(page, /generateTestsAi/);
    assert.match(page, /listRepositories/);
    assert.match(page, /unavailable until a real test runner/i);
});

test('Settings never displays hash-derived onboarding/autonomy percentages', () => {
    const page = source('pages/SettingsPage.jsx');
    assert.doesNotMatch(page, /Math\.abs\(hashCode|avgDays|fullAutonomyCount|mock autonomy/);
    assert.match(page, /does not invite anyone/i);
    assert.match(page, /Configure provider API keys and database credentials on the appropriate backend service/);
});

test('Explorer keeps source-backed navigation and valid graph modes', () => {
    const explorer = source('pages/VisualizationExplorer.jsx');
    assert.match(explorer, /buildFolderGraph\(files, dependencies\)/);
    assert.match(explorer, /graphMode === 'folder'/);
    assert.match(explorer, /activeGraph\.nodes\.length === 0/);
    assert.match(explorer, /expandAll=\{Boolean\(sidebarSearch\.trim\(\)\)\}/);
});
