import AnalysisWorker from './analysis.worker.js?worker';
import { runWorker } from './workerClient.js';

/** Identical input/output contract to orchestrator.analyzeRepository(). */
export function analyzeRepositoryOffThread(repoMeta, files, onProgress, options = {}) {
    const { signal, ...engineOptions } = options;
    return runWorker(AnalysisWorker,
        { repoMeta, files, options: engineOptions }, { onProgress, signal });
}
