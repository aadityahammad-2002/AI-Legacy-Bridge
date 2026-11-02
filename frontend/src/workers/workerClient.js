/**
 * One-shot, cancellable module Worker RPC. A worker is released immediately
 * after completion so large repository buffers are not retained by idle threads.
 * Progress messages carry no payload/result copies.
 */
export function runWorker(workerFactory, payload, { onProgress, signal, timeoutMs = 0 } = {}) {
    if (typeof Worker === 'undefined') {
        return Promise.reject(new Error('Web Workers are not available in this browser.'));
    }
    if (signal?.aborted) return Promise.reject(makeAbortError());
    return new Promise((resolve, reject) => {
        let worker;
        try { worker = typeof workerFactory === 'function' ? new workerFactory() : new Worker(workerFactory, { type: 'module' }); }
        catch (error) { reject(error); return; }
        let settled = false;
        let timeout;
        function finish(error, result) {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
            if (error) reject(error);
            else resolve(result);
        }
        function abort() { finish(makeAbortError()); }
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = ({ data }) => {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'progress') { if (!settled) onProgress?.(data.progress); return; }
            if (data.type === 'result') return finish(null, data.result);
            if (data.type === 'error') {
                const error = new Error(data.message || 'Background task failed');
                error.name = data.name || 'Error';
                finish(error);
            }
        };
        worker.onerror = (event) => {
            event.preventDefault?.();
            finish(new Error(event.message || 'Background Worker failed to load or execute.'));
        };
        worker.onmessageerror = () => finish(new Error('Background task message could not be decoded.'));
        if (timeoutMs > 0) timeout = setTimeout(() => finish(new Error('Background task timed out.')), timeoutMs);
        try { worker.postMessage(payload); }
        catch (error) { finish(error); }
    });
}

export function makeAbortError() {
    const err = new Error('Background task cancelled');
    err.name = 'AbortError';
    return err;
}

export function reportWorkerError(error) {
    self.postMessage({ type: 'error', name: error?.name || 'Error', message: error?.message || String(error) });
}
