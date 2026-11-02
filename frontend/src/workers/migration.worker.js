import { scanRepository } from './migrationScan.js';
import { reportWorkerError } from './workerClient.js';
self.onmessage = ({ data }) => {
    try { self.postMessage({ type: 'result', result: scanRepository(data.files) }); }
    catch (error) { reportWorkerError(error); }
};
