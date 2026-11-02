import JsonWorker from './json.worker.js?worker';
import { runWorker } from './workerClient.js';

/** Offload expensive stringify for large analyses. The output remains exact JSON. */
export async function stringifyAnalysisPayload(payload, { pretty = false, signal } = {}) {
    if (typeof Worker === 'undefined') return JSON.stringify(payload, null, pretty ? 2 : 0);
    return runWorker(JsonWorker, { mode: 'serialize', payload, pretty }, { signal });
}

export async function parseLargeAnalysisJson(json, { signal } = {}) {
    if (typeof Worker === 'undefined') return JSON.parse(json);
    return runWorker(JsonWorker, { mode: 'parse', json }, { signal });
}
