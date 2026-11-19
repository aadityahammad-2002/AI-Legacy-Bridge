import { Component } from 'react';
import { AlertTriangle, ArrowRight, RotateCcw } from 'lucide-react';

/** Keeps a V2 render failure isolated so the saved repository and legacy explorer stay reachable. */
export default class ExplorerV2Boundary extends Component {
    state = { error: null, retries: 0 };

    static getDerivedStateFromError(error) { return { error }; }

    componentDidCatch(error, info) {
        console.error('[Workspace V2] Explorer render failed:', error, info?.componentStack);
    }

    componentDidUpdate(previous) {
        if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        const { type, onNavigate } = this.props;
        const isGraph = type === 'visualization';
        return <section className="ws-panel lb-v2-fallback" role="alert">
            <div className="lb-v2-fallback-title"><AlertTriangle size={20}/><div><h2>{isGraph?'Visualization':'AI'} Explorer needs attention</h2><p>The updated explorer could not render this repository. Your analysis snapshot is preserved; use the original working page or retry.</p></div></div>
            <div className="lb-v2-fallback-actions">
                <button className="ws-btn" onClick={()=>this.setState(s=>({error:null,retries:s.retries+1}))}><RotateCcw size={14}/> Retry updated explorer</button>
                <button className="ws-btn primary" onClick={()=>onNavigate(isGraph?'visualization':'ai-explorer')}><ArrowRight size={14}/> Open original explorer</button>
            </div>
        </section>;
    }
}
