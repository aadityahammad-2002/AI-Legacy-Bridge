import GraphWorker from './graph.worker.js?worker';
import { runWorker } from './workerClient.js';

/** Result is a Map-compatible array of real nodeId -> coordinates. */
export function computeGraphPositions(payload, { signal } = {}) {
    return runWorker(GraphWorker, payload, { signal });
}
