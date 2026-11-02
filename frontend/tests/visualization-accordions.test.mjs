import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const explorer = readFileSync(new URL('../src/pages/VisualizationExplorer.jsx', import.meta.url), 'utf8');
const explorerCss = readFileSync(new URL('../src/pages/VisualizationExplorer.css', import.meta.url), 'utf8');
const right = readFileSync(new URL('../src/components/RepositoryPanel.jsx', import.meta.url), 'utf8');
const rightCss = readFileSync(new URL('../src/components/RepositoryPanel.css', import.meta.url), 'utf8');

test('left sidebar health, colors, stats, languages use accessible native accordions', () => {
    for (const label of ['Repository health', 'Color by', 'Repository statistics', 'Lines of code and language distribution']) {
        assert.match(explorer, new RegExp(`<details className="[^"]*viz-accordion" aria-label="${label}"`));
    }
    assert.match(explorer, /<summary className="viz-accordion__summary">/);
    assert.match(explorerCss, /\.viz-accordion\[open\].*viz-accordion__chevron/);
});

test('Explorer is collapsible, default open, with search and real folder tree intact', () => {
    assert.match(explorer, /<details className="[^"]*viz-accordion--explorer" open>/);
    assert.match(explorer, /placeholder="Search files…"/);
    assert.match(explorer, /<FolderTree files=\{filteredSidebarFiles\}/);
});

test('existing coverage and potential change impact remain collapsible', () => {
    assert.match(explorer, /<details className="[^"]*viz-coverage--collapsible" aria-label="Analysis coverage"/);
    assert.match(explorer, /<details className="[^"]*viz-coverage--collapsible" aria-label="Change impact estimate"/);
    assert.match(explorer, /<details className="[^"]*viz-coverage--collapsible" aria-label="Related test files"/);
    assert.match(explorer, /<details className="[^"]*viz-coverage--collapsible" aria-label="Potential source-to-sink flows"/);
});

test('right folder file listing and file impact can expand/collapse', () => {
    assert.match(explorer, /<details className="viz-details__section viz-accordion viz-accordion--folder-files" open>/);
    assert.match(right, /<details key=\{file\.path\} className="repo-panel__impact repo-panel__impact--collapsible">/);
    assert.match(right, /<summary className="repo-panel__impact-head">/);
    assert.match(right, /onClick=\{\(\) => onViewSource\(file\.path\)\}/);
});

test('actions collapse individually but descriptions, benefits and priority are unchanged', () => {
    assert.match(right, /<details key=\{s\.title\} className=\{`repo-panel__action/);
    for (const field of ['s.title','s.priority','s.desc','s.action','s.benefit']) assert.ok(right.includes(`{${field}}`) || right.includes(`\${${field}}`), field);
    assert.match(right, /<details className="repo-panel__duplicates repo-panel__duplicates--collapsible">/);
});

test('navigation controls, modal action buttons and existing worker hooks remain present', () => {
    for (const str of ['graph-toolbar__modes','graph-toolbar__actions','setSelectedPath','computeGraphOperation','onSelectFile','onViewSource']) assert.ok(explorer.includes(str) || right.includes(str), str);
    assert.match(right, /setModal\(\{ kind: 'issue', data: issue \}\)/);
    assert.match(right, /setModal\(\{ kind: 'security', data: s \}\)/);
    assert.match(rightCss, /\.repo-panel__action--collapsible/);
});

test('accordions have keyboard focus indicators and reduced-motion support', () => {
    assert.match(explorerCss, /\.viz-accordion > \.viz-accordion__summary:focus-visible/);
    assert.match(rightCss, /\.repo-panel__impact--collapsible > summary:focus-visible/);
    assert.match(explorerCss, /prefers-reduced-motion: reduce/);
    assert.match(rightCss, /prefers-reduced-motion: reduce/);
});
