import { readZipRepositoryMainThread } from '../repo-sources/zipCore.js';
import { reportWorkerError } from './workerClient.js';
self.onmessage = async ({ data }) => {
    try {
        const result = await readZipRepositoryMainThread(data.zipFile, (progress) => self.postMessage({ type: 'progress', progress }));
        self.postMessage({ type: 'result', result });
    } catch (error) { reportWorkerError(error); }
};
