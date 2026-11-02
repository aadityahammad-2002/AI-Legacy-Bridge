import { Component } from 'react';

/** Keep a malformed/unsupported graph layout from blanking the entire workspace. */
export default class VisualizationErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
    }
    static getDerivedStateFromError(error) {
        return { failed: true, message: error?.message || 'Graph view could not be rendered.' };
    }
    componentDidCatch(error, info) {
        console.error('[Visualization] failed to render graph view', error, info);
    }
    retry = () => {
        this.setState({ failed: false, message: '' });
        this.props.onReset?.();
    };
    render() {
        if (!this.state.failed) return this.props.children;
        return (
            <div role="alert" style={{ padding: '28px', maxWidth: '560px', margin: 'auto', color: 'var(--lb-text)' }}>
                <h3>Graph view unavailable</h3>
                <p>The repository analysis is still available. A visualization error does not imply the underlying graph was lost.</p>
                <p style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', fontSize: 12 }}>{this.state.message}</p>
                <button type="button" onClick={this.retry} style={{ padding: '9px 16px', cursor: 'pointer' }}>Return to dependency graph</button>
            </div>
        );
    }
}
