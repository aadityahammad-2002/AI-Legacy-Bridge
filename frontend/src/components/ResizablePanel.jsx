import { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './ResizablePanel.css';

/**
 * A collapsible, resizable side panel with a drag handle on one edge.
 * Width and collapsed-state persist to localStorage per `storageKey`, so
 * they survive navigating away and back (Task 2: "Width persistence").
 *
 * Used for AI Explorer's file-tree (side="left") and AI Assistant
 * (side="right") panels — see AiExplorer.jsx.
 */
export default function ResizablePanel({
    side,
    storageKey,
    defaultWidth = 260,
    minWidth = 180,
    maxWidth = 480,
    collapsedWidth = 44,
    children,
}) {
    const [width, setWidth] = useState(() => {
        const saved = Number(localStorage.getItem(`${storageKey}:width`));
        return Number.isFinite(saved) && saved > 0 ? saved : defaultWidth;
    });
    const [collapsed, setCollapsed] = useState(
        () => localStorage.getItem(`${storageKey}:collapsed`) === 'true'
    );
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef({ x: 0, width });

    useEffect(() => {
        localStorage.setItem(`${storageKey}:width`, String(width));
    }, [width, storageKey]);

    useEffect(() => {
        localStorage.setItem(`${storageKey}:collapsed`, String(collapsed));
    }, [collapsed, storageKey]);

    const handlePointerDown = useCallback((e) => {
        setIsDragging(true);
        dragStartRef.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
    }, [width]);

    const handlePointerMove = useCallback((e) => {
        if (e.buttons !== 1) return;
        const delta = e.clientX - dragStartRef.current.x;
        const signedDelta = side === 'left' ? delta : -delta;
        setWidth(Math.min(maxWidth, Math.max(minWidth, dragStartRef.current.width + signedDelta)));
    }, [side, minWidth, maxWidth]);

    const handlePointerUp = useCallback((e) => {
        setIsDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
    }, []);

    const handleDoubleClick = useCallback(() => setWidth(defaultWidth), [defaultWidth]);

    const effectiveWidth = collapsed ? collapsedWidth : width;
    const CollapseIcon = side === 'left'
        ? (collapsed ? ChevronRight : ChevronLeft)
        : (collapsed ? ChevronLeft : ChevronRight);

    return (
        <div
            className={
                `resizable-panel resizable-panel--${side}` +
                (collapsed ? ' resizable-panel--collapsed' : '') +
                (isDragging ? ' resizable-panel--dragging' : '')
            }
            style={{ width: effectiveWidth }}
        >
            <button
                className="resizable-panel__collapse-btn"
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? 'Expand panel' : 'Collapse panel'}
            >
                <CollapseIcon size={13} strokeWidth={2} />
            </button>

            {!collapsed && <div className="resizable-panel__content">{children}</div>}

            {!collapsed && (
                <div
                    className={`resizable-panel__handle resizable-panel__handle--${side}`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onDoubleClick={handleDoubleClick}
                    title="Drag to resize · double-click to reset"
                />
            )}
        </div>
    );
}
