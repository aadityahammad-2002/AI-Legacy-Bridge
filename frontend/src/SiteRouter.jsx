import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import LandingPage from './pages/LandingPage.jsx';

// Keep the heavy Analysis Engine and product workspaces out of the landing bundle.
const App = lazy(() => import('./App.jsx'));

/**
 * Tiny URL router deliberately independent of react-router.
 * The existing App remains the owner of upload, repository, and workspace state.
 * Root URL = marketing landing page; /app = existing application.
 */
function resolveRoute(pathname) {
    return pathname === '/app' || pathname === '/app/' ? 'app' : 'landing';
}

export default function SiteRouter() {
    const [route, setRoute] = useState(() => resolveRoute(window.location.pathname));
    // Clicking Get Started explicitly opens UploadPage. A browser reload at
    // /app still restores an existing repository through App's normal logic.
    const [startOnUpload, setStartOnUpload] = useState(false);

    useEffect(() => {
        const onHistoryChange = () => {
            setStartOnUpload(false);
            setRoute(resolveRoute(window.location.pathname));
        };
        window.addEventListener('popstate', onHistoryChange);
        return () => window.removeEventListener('popstate', onHistoryChange);
    }, []);

    const launchApp = useCallback(() => {
        if (resolveRoute(window.location.pathname) !== 'app') {
            window.history.pushState({ legacyBridge: 'app' }, '', '/app');
        }
        // Avoid landing at the old section's scroll position after switching.
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        setStartOnUpload(true);
        setRoute('app');
    }, []);

    return route === 'landing'
        ? <LandingPage onLaunch={launchApp} />
        : (
            <Suspense fallback={<div role="status" style={{ padding: 28, color: '#c5b4fa', fontFamily: 'Inter, sans-serif' }}>Opening the application…</div>}>
                <App startOnUpload={startOnUpload} />
            </Suspense>
        );
}
