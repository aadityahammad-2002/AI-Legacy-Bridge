import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import React from 'react';

// Monaco doesn't run in jsdom (no real canvas/workers) — mock it with a
// minimal stand-in that exposes enough for the tab-switching test below.
vi.mock('@monaco-editor/react', () => ({
    default: ({ value, language }) => React.createElement('pre', { 'data-testid': 'mock-editor', 'data-language': language }, value),
}));

// vi.mock() factories are hoisted above all imports/top-level consts, so the
// mock function they reference must be created via vi.hoisted() rather than
// a plain `const` — otherwise it'd be accessed before initialization.
const { mockAskAi } = vi.hoisted(() => ({ mockAskAi: vi.fn() }));
vi.mock('./src/api/backend.js', () => ({
    askAi: (...args) => mockAskAi(...args),
    ingestAnalysis: vi.fn(),
}));

import VisualizationExplorer from './src/pages/VisualizationExplorer.jsx';
import WorkspaceSelectionPage from './src/pages/WorkspaceSelectionPage.jsx';
import AiExplorer from './src/pages/AiExplorer.jsx';

const mockAnalysisResult = {
    repository: { name: 'demo-repo', source: 'zip' },
    files: [
        { path: 'src/controller/UserController.java', language: 'java', loc: 30 },
        { path: 'src/service/UserService.java', language: 'java', loc: 45 },
        { path: 'src/repository/UserRepository.java', language: 'java', loc: 12 },
    ],
    classes: [
        { name: 'UserController', file: 'src/controller/UserController.java', package: 'com.app.controller', line: 5, annotations: ['RestController'] },
        { name: 'UserService', file: 'src/service/UserService.java', package: 'com.app.service', line: 5, annotations: ['Service'] },
    ],
    functions: [
        { name: 'createUser', file: 'src/service/UserService.java', line: 10, endLine: 12, type: 'method', isTopLevel: false, isExported: false, code: '...' },
        { name: 'deleteUser', file: 'src/service/UserService.java', line: 14, endLine: 16, type: 'method', isTopLevel: false, isExported: false, code: '...' },
    ],
    imports: [
        { source: 'src/controller/UserController.java', target: 'src/service/UserService.java', type: 'import' },
    ],
    dependencies: [
        { source: 'src/controller/UserController.java', target: 'src/service/UserService.java', type: 'import' },
        { source: 'src/service/UserService.java', target: 'src/repository/UserRepository.java', type: 'import' },
    ],
    graph: {
        nodes: [
            { id: 'src/controller/UserController.java', label: 'UserController.java' },
            { id: 'src/service/UserService.java', label: 'UserService.java' },
            { id: 'src/repository/UserRepository.java', label: 'UserRepository.java' },
        ],
        edges: [
            { source: 'src/controller/UserController.java', target: 'src/service/UserService.java' },
            { source: 'src/service/UserService.java', target: 'src/repository/UserRepository.java' },
        ],
    },
    patterns: [],
    securityIssues: [],
    duplicates: [],
    healthScore: { score: 88, grade: 'A' },
    fileContents: {
        'src/controller/UserController.java': 'public class UserController {\n    // ...\n}\n',
        'src/service/UserService.java': 'public class UserService {\n    public User createUser() { return null; }\n}\n',
        'src/repository/UserRepository.java': 'public interface UserRepository {}\n',
    },
};

function renderAndFlush(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(element);
    });
    return { container, root };
}

describe('Page render smoke tests (with real mock analysis data)', () => {
    it('renders VisualizationExplorer without throwing, and shows health/metrics/graph', async () => {
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: () => {},
            })
        );
        // let the d3-force useEffect run
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(container.textContent).toContain('Health Score');
        expect(container.textContent).toContain('Files');
        expect(container.querySelector('.stat-grid').textContent).toContain('3'); // file count
        expect(container.textContent).toContain('Functions');
        expect(container.textContent).toContain('Links');
        expect(container.textContent).toContain('Unused');
        expect(container.querySelector('svg')).toBeTruthy();
        root.unmount();
    });

    it('selecting a file in the tree shows its details and an Open AI Explorer button', async () => {
        let capturedContext = null;
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: (ctx) => { capturedContext = ctx; },
            })
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        // Expand top-level tree folder then click the UserService.java row
        const rows = [...container.querySelectorAll('.folder-tree__row')];
        const serviceFolder = rows.find((r) => r.textContent.includes('service'));
        act(() => { serviceFolder?.click(); });

        const fileRow = [...container.querySelectorAll('.folder-tree__row--file')]
            .find((r) => r.textContent.includes('UserService.java'));
        expect(fileRow).toBeTruthy();
        act(() => { fileRow.click(); });

        expect(container.textContent).toContain('createUser()');
        expect(container.textContent).toContain('Open AI Explorer');

        const aiBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Open AI Explorer'));
        act(() => { aiBtn.click(); });
        expect(capturedContext).toBeTruthy();
        expect(capturedContext.selectedNode).toBe('src/service/UserService.java');

        root.unmount();
    });

    it('opens the graph settings popup and switches layout mode', async () => {
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: () => {},
            })
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        const gearBtn = container.querySelector('.graph-settings__gear');
        expect(gearBtn).toBeTruthy();
        act(() => { fireEvent.click(gearBtn); });

        expect(container.textContent).toContain('Layout');
        expect(container.textContent).toContain('Radial');
        expect(container.textContent).toContain('Metro');

        const radialBtn = [...container.querySelectorAll('.graph-settings__layout-btn')].find((b) => b.textContent === 'Radial');
        act(() => { fireEvent.click(radialBtn); });
        expect(radialBtn.className).toContain('graph-settings__layout-btn--active');

        root.unmount();
    });

    it('zoom in/out buttons actually change the graph <g> transform attribute in the DOM', async () => {
        // This asserts the real DOM effect of clicking the zoom buttons, not just
        // "doesn't throw" — the whole point is to catch a regression where the
        // buttons appear to do nothing visually (see DEVELOPMENT_PROGRESS.md: the
        // zoom transform used to route through React state and re-render the
        // entire node/edge tree instead of updating the DOM directly).
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: () => {},
            })
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        const g = container.querySelector('.graph-canvas__svg > g');
        expect(g).toBeTruthy();
        const initialTransform = g.getAttribute('transform');

        // Use "Zoom out" rather than "Zoom in" here: this test's small mock graph has
        // its nodes tightly clustered in a small area, so the automatic fitView() on
        // load already lands at MAX_ZOOM — "zoom in" from there is correctly a no-op
        // (there's nowhere further to zoom in to), which isn't the thing this test
        // wants to exercise. Zooming out is guaranteed to actually change the scale.
        const zoomOutBtn = [...container.querySelectorAll('button')].find((b) => b.title === 'Zoom out');
        expect(zoomOutBtn).toBeTruthy();
        act(() => { fireEvent.click(zoomOutBtn); });
        // Zoom-button clicks are intentionally instant (no transition/RAF — see
        // the comment on zoomBy in GraphCanvas.jsx), so the DOM should already
        // reflect the new transform synchronously, no waiting required.

        const afterZoomTransform = g.getAttribute('transform');
        expect(afterZoomTransform).not.toBe(initialTransform);
        // Specifically, the scale factor should have decreased (zoom OUT).
        const initialScale = Number(initialTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? '1');
        const afterScale = Number(afterZoomTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? '1');
        expect(afterScale).toBeLessThan(initialScale);

        root.unmount();
    });

    it('dragging the empty canvas background pans the graph (updates the <g> transform)', async () => {
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: () => {},
            })
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        const svg = container.querySelector('.graph-canvas__svg');
        const g = container.querySelector('.graph-canvas__svg > g');
        expect(svg).toBeTruthy();
        const initialTransform = g.getAttribute('transform');

        // Simulate a pointer-drag on the empty canvas background (not on a node) —
        // pointerdown, then pointermove some distance away, then pointerup.
        act(() => {
            fireEvent.pointerDown(svg, { clientX: 200, clientY: 200, pointerId: 1, button: 0 });
            fireEvent.pointerMove(svg, { clientX: 260, clientY: 240, pointerId: 1 });
            fireEvent.pointerUp(svg, { clientX: 260, clientY: 240, pointerId: 1 });
        });

        const afterPanTransform = g.getAttribute('transform');
        expect(afterPanTransform).not.toBe(initialTransform);
        // Pan only translates (x/y) — scale (k) should be unchanged.
        const panInitialScale = initialTransform.match(/scale\(([\d.]+)\)/)?.[1];
        const panAfterScale = afterPanTransform.match(/scale\(([\d.]+)\)/)?.[1];
        expect(panAfterScale).toBe(panInitialScale);

        root.unmount();
    });

    it('a wheel event over the canvas zooms toward the cursor (trackpad pinch fires as ctrlKey+wheel)', async () => {
        const { container, root } = renderAndFlush(
            React.createElement(VisualizationExplorer, {
                analysisResult: mockAnalysisResult,
                activeWorkspace: 'visualization',
                onNavigate: () => {},
                onExitRepository: () => {},
                onOpenAiExplorerFocused: () => {},
            })
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        const svg = container.querySelector('.graph-canvas__svg');
        const g = container.querySelector('.graph-canvas__svg > g');
        const wheelInitialScale = Number(g.getAttribute('transform').match(/scale\(([\d.]+)\)/)?.[1]);

        // Positive deltaY = pinch-in / scroll-down = zoom OUT (this mock graph's
        // nodes are tightly clustered, so the automatic fitView() on load already
        // lands at MAX_ZOOM — zooming IN further from there is correctly a no-op,
        // same reasoning as the zoom-out-button test above). Browsers report a
        // trackpad pinch gesture as a wheel event with ctrlKey: true — included
        // here so this test covers that exact case, not just a plain mouse-wheel
        // notch.
        act(() => {
            fireEvent.wheel(svg, { deltaY: 100, ctrlKey: true, clientX: 300, clientY: 200 });
        });

        const wheelAfterScale = Number(g.getAttribute('transform').match(/scale\(([\d.]+)\)/)?.[1]);
        expect(wheelAfterScale).toBeLessThan(wheelInitialScale);

        root.unmount();
    });

    it('renders WorkspaceSelectionPage without throwing', () => {
        const { container, root } = renderAndFlush(
            React.createElement(WorkspaceSelectionPage, {
                repoMeta: mockAnalysisResult.repository,
                onEnterWorkspace: () => {},
                onExitRepository: () => {},
            })
        );
        expect(container.textContent).toContain('Visualization Explorer');
        expect(container.textContent).toContain('AI Explorer');
        expect(container.textContent).toContain('demo-repo');
        root.unmount();
    });

    it('renders AiExplorer without throwing, opens files as tabs, and shows their content in the (mocked) editor', () => {
        const { container, root } = renderAndFlush(
            React.createElement(AiExplorer, {
                repositoryId: 'repo-123',
                analysisResult: mockAnalysisResult,
                focusedContext: { selectedNode: 'src/service/UserService.java', directDependencies: ['src/repository/UserRepository.java'] },
                activeWorkspace: 'ai-explorer',
                onNavigate: () => {},
                onExitRepository: () => {},
            })
        );

        // Focused context should have opened UserService.java as a tab automatically
        expect(container.textContent).toContain('AI Assistant (Focused)');
        expect(container.textContent).toContain('UserService.java');
        const editor = container.querySelector('[data-testid="mock-editor"]');
        expect(editor).toBeTruthy();
        expect(editor.textContent).toContain('createUser');
        expect(editor.getAttribute('data-language')).toBe('java');

        // Open a second file via the folder tree and switch to it
        const rows = [...container.querySelectorAll('.folder-tree__row')];
        const repoFolder = rows.find((r) => r.textContent.includes('repository'));
        act(() => { repoFolder?.click(); });
        const repoFileRow = [...container.querySelectorAll('.folder-tree__row--file')]
            .find((r) => r.textContent.includes('UserRepository.java'));
        act(() => { repoFileRow.click(); });

        expect(container.querySelector('[data-testid="mock-editor"]').textContent).toContain('interface UserRepository');

        // Two tabs should now be open
        const tabs = container.querySelectorAll('.ai-explorer__tab');
        expect(tabs.length).toBe(2);

        root.unmount();
    });

    it('sends a chat message and displays the (mocked) AI response with agent + source files', async () => {
        mockAskAi.mockResolvedValueOnce({
            answer: 'UserService.createUser() saves a new user via UserRepository.',
            agentUsed: 'GENERAL',
            sourceFiles: ['src/service/UserService.java'],
        });

        const { container, root } = renderAndFlush(
            React.createElement(AiExplorer, {
                repositoryId: 'repo-123',
                analysisResult: mockAnalysisResult,
                focusedContext: { selectedNode: 'src/service/UserService.java', directDependencies: [] },
                activeWorkspace: 'ai-explorer',
                onNavigate: () => {},
                onExitRepository: () => {},
            })
        );

        const input = container.querySelector('.ai-explorer__chat-input-row input');
        const sendBtn = container.querySelector('.ai-explorer__chat-input-row button');

        act(() => {
            fireEvent.change(input, { target: { value: 'Explain UserService' } });
        });
        expect(sendBtn.disabled).toBe(false);

        await act(async () => {
            sendBtn.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockAskAi).toHaveBeenCalledWith('repo-123', 'Explain UserService', 'src/service/UserService.java', 'src/service/UserService.java');
        expect(container.textContent).toContain('Explain UserService'); // user message
        expect(container.textContent).toContain('saves a new user via UserRepository'); // assistant response
        expect(container.textContent).toContain('GENERAL'); // agent badge
        expect(container.textContent).toContain('UserService.java'); // source chip

        root.unmount();
    });

    it('Task 6: sends the currently-open file as openFilePath, distinct from focusedNode, when the user switches tabs', async () => {
        mockAskAi.mockResolvedValueOnce({ answer: 'ok', agentUsed: 'GENERAL', sourceFiles: [] });

        const { container, root } = renderAndFlush(
            React.createElement(AiExplorer, {
                repositoryId: 'repo-123',
                analysisResult: mockAnalysisResult,
                // Focused on UserService, but the user is about to switch to viewing UserRepository —
                // openFilePath should track the latter, focusedNode should stay the former.
                focusedContext: { selectedNode: 'src/service/UserService.java', directDependencies: [] },
                activeWorkspace: 'ai-explorer',
                onNavigate: () => {},
                onExitRepository: () => {},
            })
        );

        // Switch to a different file via the folder tree.
        const rows = [...container.querySelectorAll('.folder-tree__row')];
        const repoFolder = rows.find((r) => r.textContent.includes('repository'));
        act(() => { repoFolder?.click(); });
        const repoFileRow = [...container.querySelectorAll('.folder-tree__row--file')]
            .find((r) => r.textContent.includes('UserRepository.java'));
        act(() => { repoFileRow.click(); });

        const input = container.querySelector('.ai-explorer__chat-input-row input');
        const sendBtn = container.querySelector('.ai-explorer__chat-input-row button');
        act(() => { fireEvent.change(input, { target: { value: 'What does this do?' } }); });
        await act(async () => {
            sendBtn.click();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockAskAi).toHaveBeenCalledWith(
            'repo-123', 'What does this do?',
            'src/service/UserService.java',   // focusedNode — unchanged, still the Focused Mode target
            'src/repository/UserRepository.java' // openFilePath — the file actually open now
        );

        root.unmount();
    });
});
