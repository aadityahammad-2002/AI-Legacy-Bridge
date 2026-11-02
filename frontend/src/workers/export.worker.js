import { toDownloadableAnalysisJson } from '../analysis-engine/reportFormats.js';
import { reportWorkerError } from './workerClient.js';
self.onmessage = ({ data }) => {
    try {
        const result = toDownloadableAnalysisJson(data.analysisResult, data.repoMeta);
        self.postMessage({ type: 'result', result });
    } catch (error) { reportWorkerError(error); }
};
