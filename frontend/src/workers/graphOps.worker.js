import { buildFolderGraph } from '../components/graphData.js';
import { computeChangeImpact } from '../analysis-engine/changeImpact.js';
import { reportWorkerError } from './workerClient.js';
self.onmessage = ({ data }) => {
    try {
        let result;
        if (data.mode === 'folders') result = buildFolderGraph(data.files, data.dependencies);
        else if (data.mode === 'impact') result = computeChangeImpact(data.path, data.dependencies, data.diagnostics);
        else if (data.mode === 'filter') {
            const needle = String(data.needle || '').trim().toLowerCase();
            result = data.paths.filter((p) => p.toLowerCase().includes(needle));
        } else throw new Error('Unsupported graph operation');
        self.postMessage({ type: 'result', result });
    } catch (error) { reportWorkerError(error); }
};
