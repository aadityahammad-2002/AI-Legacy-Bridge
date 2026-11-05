import { toWorkspaceAnalysisSourceJson } from '../export/workspaceAnalysisSourceExport.js';
import { reportWorkerError } from './workerClient.js';
self.onmessage = ({ data }) => {
    try {
        const result = toWorkspaceAnalysisSourceJson(data.analysisResult, data.repoMeta);
        self.postMessage({ type: 'result', result });
    } catch (error) { reportWorkerError(error); }
};
