import { describe, it, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import React from 'react';

import RepositoryPanel from './src/components/RepositoryPanel.jsx';

// Minimal but shape-accurate analysisResult — mirrors what analyzeRepository()
// (orchestrator.js) actually returns, so calcBlast/fnStats lookups behave the
// same as in production. See DEVELOPMENT_PROGRESS.md Entry 17/18.
const files = [
    { path: 'src/service/UserService.java', loc: 20, content: 'public class UserService {\n    public User createUser() { return null; }\n}\n', complexity: { score: 2, level: 'low' } },
    { path: 'src/controller/UserController.java', loc: 15, content: 'class UserController {\n  x() { createUser(); }\n}\n', complexity: { score: 1, level: 'low' } },
];

const analysisResult = {
    files,
    functions: [
        { name: 'createUser', file: 'src/service/UserService.java', line: 2, endLine: 2, code: 'public User createUser() { return null; }' },
    ],
    dependencies: [
        { source: 'src/service/UserService.java', target: 'src/controller/UserController.java', type: 'import' },
    ],
    issues: [
        { type: 'critical', title: '1 Large Files', desc: 'Files with 15+ functions', items: [{ name: 'UserService.java', file: 'src/service/UserService.java' }] },
    ],
    patterns: [
        { name: 'Factory', icon: 'factory', desc: 'Creates objects without specifying exact class.', severity: 'info', files: [{ name: 'UserService.java', path: 'src/service/UserService.java' }], metrics: { factories: 1 } },
    ],
    securityIssues: [
        { severity: 'high', title: 'Hardcoded Secret', file: 'UserService.java', path: 'src/service/UserService.java', line: 3, desc: 'Credentials should never be hardcoded.', code: "var token = 'abcd1234'" },
    ],
    duplicates: [
        { type: 'name', name: 'createUser', count: 2, files: ['src/service/UserService.java', 'src/controller/UserController.java'] },
    ],
    callGraph: {
        connections: [
            { source: 'src/service/UserService.java', target: 'src/controller/UserController.java', fn: 'createUser', count: 1, functionKey: 'src/service/UserService.java|2|createUser' },
        ],
        fnStats: {
            'src/service/UserService.java|2|createUser': { internal: 0, external: 1 },
        },
    },
};

function renderAndFlush(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(element); });
    return { container, root };
}

describe('RepositoryPanel', () => {
    it('renders the Issues tab by default and shows tab counts', () => {
        const { container, root } = renderAndFlush(
            React.createElement(RepositoryPanel, { analysisResult, selectedPath: null, onSelectPath: () => {} })
        );
        expect(container.textContent).toContain('Architecture Issues (1)');
        expect(container.textContent).toContain('1 Large Files');
        root.unmount();
    });

    it('clicking an issue card opens a detail modal with its items', () => {
        const { container, root } = renderAndFlush(
            React.createElement(RepositoryPanel, { analysisResult, selectedPath: null, onSelectPath: () => {} })
        );
        const card = [...container.querySelectorAll('.repo-panel__card')].find((c) => c.textContent.includes('Large Files'));
        act(() => { fireEvent.click(card); });
        // The modal renders via a portal into document.body (see RepositoryPanel.jsx —
        // needed so it isn't trapped inside this panel's own backdrop-filter stacking/
        // containing-block context), so it won't appear under `container` — check
        // document.body instead.
        expect(document.body.textContent).toContain('All Locations (1)');
        expect(document.body.textContent).toContain('UserService.java');
        root.unmount();
    });

    it('switches to Patterns, Security, and Actions tabs', () => {
        const { container, root } = renderAndFlush(
            React.createElement(RepositoryPanel, { analysisResult, selectedPath: null, onSelectPath: () => {} })
        );
        const tabs = [...container.querySelectorAll('.repo-panel__tab')];
        act(() => { fireEvent.click(tabs.find((t) => t.textContent.includes('Patterns'))); });
        expect(container.textContent).toContain('Factory');

        act(() => { fireEvent.click(tabs.find((t) => t.textContent.includes('Security'))); });
        expect(container.textContent).toContain('Hardcoded Secret');

        act(() => { fireEvent.click(tabs.find((t) => t.textContent.includes('Actions'))); });
        expect(container.textContent).toContain('Split Large Files');
        expect(container.textContent).toContain('Fix Security Issues');
        expect(container.textContent).toContain('Same Name:');
        root.unmount();
    });

    it('shows the File tab with Impact Analysis when a file is selected', () => {
        let selected = 'src/service/UserService.java';
        const { container, root, rerender } = (() => {
            const r = renderAndFlush(
                React.createElement(RepositoryPanel, {
                    analysisResult, selectedPath: selected, onSelectPath: (p) => { selected = p; },
                })
            );
            return { ...r, rerender: () => r.root.render(React.createElement(RepositoryPanel, { analysisResult, selectedPath: selected, onSelectPath: () => {} })) };
        })();

        expect(container.textContent).toContain('Impact Analysis');
        expect(container.textContent).toContain('Direct Dependents');
        expect(container.textContent).toContain('UserService.java');
        // The one connection (UserController importing createUser) should show as a direct dependent
        expect(container.textContent).toContain('UserController.java');
        root.unmount();
    });

    it('clicking "Back to Issues" in the File view clears the selection', () => {
        const clicked = [];
        const { container, root } = renderAndFlush(
            React.createElement(RepositoryPanel, {
                analysisResult, selectedPath: 'src/service/UserService.java', onSelectPath: (p) => clicked.push(p),
            })
        );
        const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Back to Issues'));
        act(() => { fireEvent.click(backBtn); });
        expect(clicked).toContain(null);
        root.unmount();
    });
});
