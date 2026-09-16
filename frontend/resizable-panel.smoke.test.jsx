import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import React from 'react';

import ResizablePanel from './src/components/ResizablePanel.jsx';

function renderAndFlush(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(element);
    });
    return { container, root };
}

function firePointer(el, type, props) {
    const event = new window.PointerEvent(type, { bubbles: true, cancelable: true, ...props });
    // jsdom doesn't implement pointer capture — stub it so the component's calls don't throw.
    el.setPointerCapture = el.setPointerCapture || (() => {});
    el.releasePointerCapture = el.releasePointerCapture || (() => {});
    act(() => {
        el.dispatchEvent(event);
    });
}

beforeEach(() => {
    localStorage.clear();
});

describe('ResizablePanel', () => {
    it('renders children at the default width when nothing is persisted yet', () => {
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, { side: 'left', storageKey: 'test-panel', defaultWidth: 260 },
                React.createElement('div', { 'data-testid': 'child' }, 'Hello'))
        );
        const panel = container.querySelector('.resizable-panel');
        expect(panel.style.width).toBe('260px');
        expect(container.textContent).toContain('Hello');
        root.unmount();
    });

    it('collapsing hides the content and persists the collapsed state', () => {
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, { side: 'left', storageKey: 'test-panel', defaultWidth: 260 },
                React.createElement('div', null, 'Hello'))
        );

        const collapseBtn = container.querySelector('.resizable-panel__collapse-btn');
        act(() => { collapseBtn.click(); });

        expect(container.querySelector('.resizable-panel').classList.contains('resizable-panel--collapsed')).toBe(true);
        expect(container.querySelector('.resizable-panel__content')).toBeFalsy();
        expect(localStorage.getItem('test-panel:collapsed')).toBe('true');

        // Expanding again restores it and updates persistence.
        act(() => { collapseBtn.click(); });
        expect(container.querySelector('.resizable-panel').classList.contains('resizable-panel--collapsed')).toBe(false);
        expect(localStorage.getItem('test-panel:collapsed')).toBe('false');

        root.unmount();
    });

    it('starts collapsed if a previous session left it collapsed (persistence across mounts)', () => {
        localStorage.setItem('test-panel:collapsed', 'true');
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, { side: 'left', storageKey: 'test-panel', defaultWidth: 260 },
                React.createElement('div', null, 'Hello'))
        );
        expect(container.querySelector('.resizable-panel').classList.contains('resizable-panel--collapsed')).toBe(true);
        root.unmount();
    });

    it('dragging the handle resizes the panel (left side: dragging right increases width) and persists the new width', () => {
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, {
                side: 'left', storageKey: 'test-panel', defaultWidth: 260, minWidth: 180, maxWidth: 480,
            }, React.createElement('div', null, 'Hello'))
        );

        const handle = container.querySelector('.resizable-panel__handle');
        firePointer(handle, 'pointerdown', { clientX: 100, pointerId: 1 });
        firePointer(handle, 'pointermove', { clientX: 150, pointerId: 1, buttons: 1 }); // +50px right
        firePointer(handle, 'pointerup', { clientX: 150, pointerId: 1 });

        const panel = container.querySelector('.resizable-panel');
        expect(panel.style.width).toBe('310px'); // 260 + 50
        expect(localStorage.getItem('test-panel:width')).toBe('310');

        root.unmount();
    });

    it('clamps width to minWidth/maxWidth even if the drag would exceed them', () => {
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, {
                side: 'left', storageKey: 'test-panel', defaultWidth: 260, minWidth: 180, maxWidth: 480,
            }, React.createElement('div', null, 'Hello'))
        );

        const handle = container.querySelector('.resizable-panel__handle');
        firePointer(handle, 'pointerdown', { clientX: 100, pointerId: 1 });
        firePointer(handle, 'pointermove', { clientX: 2000, pointerId: 1, buttons: 1 }); // huge drag right
        firePointer(handle, 'pointerup', { clientX: 2000, pointerId: 1 });

        expect(container.querySelector('.resizable-panel').style.width).toBe('480px'); // clamped to maxWidth

        root.unmount();
    });

    it('loads a previously-persisted width on mount', () => {
        localStorage.setItem('test-panel:width', '333');
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, { side: 'left', storageKey: 'test-panel', defaultWidth: 260 },
                React.createElement('div', null, 'Hello'))
        );
        expect(container.querySelector('.resizable-panel').style.width).toBe('333px');
        root.unmount();
    });

    it('double-clicking the handle resets width to defaultWidth', () => {
        localStorage.setItem('test-panel:width', '420');
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, { side: 'left', storageKey: 'test-panel', defaultWidth: 260 },
                React.createElement('div', null, 'Hello'))
        );
        expect(container.querySelector('.resizable-panel').style.width).toBe('420px');

        const handle = container.querySelector('.resizable-panel__handle');
        act(() => {
            handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
        });

        expect(container.querySelector('.resizable-panel').style.width).toBe('260px');
        expect(localStorage.getItem('test-panel:width')).toBe('260');

        root.unmount();
    });

    it('on the right side, dragging left (negative clientX delta) increases width (handle is on the left edge)', () => {
        const { container, root } = renderAndFlush(
            React.createElement(ResizablePanel, {
                side: 'right', storageKey: 'test-panel-right', defaultWidth: 300, minWidth: 220, maxWidth: 460,
            }, React.createElement('div', null, 'Hello'))
        );

        const handle = container.querySelector('.resizable-panel__handle');
        firePointer(handle, 'pointerdown', { clientX: 200, pointerId: 1 });
        firePointer(handle, 'pointermove', { clientX: 150, pointerId: 1, buttons: 1 }); // dragged 50px left
        firePointer(handle, 'pointerup', { clientX: 150, pointerId: 1 });

        expect(container.querySelector('.resizable-panel').style.width).toBe('350px'); // 300 + 50

        root.unmount();
    });
});
