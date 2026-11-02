import GraphOpsWorker from './graphOps.worker.js?worker';
import { runWorker } from './workerClient.js';
export function computeGraphOperation(payload, { signal } = {}) {
    return runWorker(GraphOpsWorker, payload, { signal });
}
