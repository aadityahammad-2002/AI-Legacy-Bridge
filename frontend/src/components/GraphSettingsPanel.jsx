import { Settings } from 'lucide-react';
import './GraphSettingsPanel.css';

const LAYOUTS = [
    { id: 'force', label: 'Force' },
    { id: 'radial', label: 'Radial' },
    { id: 'layers', label: 'Layers' },
    { id: 'grid', label: 'Grid' },
];

/**
 * Gear-icon popup for graph display settings — layout algorithm, a "Metro"
 * grid-snap toggle, spacing sliders, and display checkboxes. 
 * settings popup (see DEVELOPMENT_PROGRESS.md, Point 3). All
 * state is owned by the parent (VisualizationExplorer) and passed straight
 * through to GraphCanvas — this component is just the picker UI.
 */
export default function GraphSettingsPanel({
    open, onToggle,
    layoutMode, onLayoutModeChange,
    metroSnap, onMetroSnapChange,
    spacingSpread, onSpacingSpreadChange,
    spacingLinks, onSpacingLinksChange,
    showLabels, onShowLabelsChange,
    curvedLinks, onCurvedLinksChange,
}) {
    return (
        <div className="graph-settings">
            <button
                title="Graph settings"
                className={`graph-settings__gear${open ? ' graph-settings__gear--active' : ''}`}
                onClick={onToggle}
            >
                <Settings size={14} strokeWidth={1.8} />
            </button>

            {open && (
                <div className="graph-settings__popup">
                    <div className="graph-settings__label">Layout</div>
                    <div className="graph-settings__layout-row">
                        {LAYOUTS.map((l) => (
                            <button
                                key={l.id}
                                className={`graph-settings__layout-btn${layoutMode === l.id ? ' graph-settings__layout-btn--active' : ''}`}
                                onClick={() => onLayoutModeChange(l.id)}
                            >
                                {l.label}
                            </button>
                        ))}
                    </div>
                    <button
                        className={`graph-settings__metro-btn${metroSnap ? ' graph-settings__metro-btn--active' : ''}`}
                        onClick={() => onMetroSnapChange(!metroSnap)}
                    >
                        Metro
                    </button>

                    <div className="graph-settings__label graph-settings__label--spaced">Spacing</div>
                    <label className="graph-settings__slider-row">
                        <span>Spread</span>
                        <input
                            type="range" min="0" max="1" step="0.05"
                            value={spacingSpread}
                            onChange={(e) => onSpacingSpreadChange(Number(e.target.value))}
                        />
                    </label>
                    <label className="graph-settings__slider-row">
                        <span>Links</span>
                        <input
                            type="range" min="0" max="1" step="0.05"
                            value={spacingLinks}
                            onChange={(e) => onSpacingLinksChange(Number(e.target.value))}
                        />
                    </label>

                    <div className="graph-settings__label graph-settings__label--spaced">Display</div>
                    <label className="graph-settings__check-row">
                        <input type="checkbox" checked={showLabels} onChange={(e) => onShowLabelsChange(e.target.checked)} />
                        Show labels
                    </label>
                    <label className="graph-settings__check-row">
                        <input type="checkbox" checked={curvedLinks} onChange={(e) => onCurvedLinksChange(e.target.checked)} />
                        Curved links
                    </label>
                </div>
            )}
        </div>
    );
}
