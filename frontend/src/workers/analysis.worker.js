import * as acorn from 'acorn';
import * as Babel from '@babel/standalone';
import { configureAnalysisEngine, analyzeRepository } from '../analysis-engine/orchestrator.js';
import { reportWorkerError } from './workerClient.js';

configureAnalysisEngine({ acorn, Babel });
self.onmessage = async ({ data }) => {
    try {
        const result = await analyzeRepository(data.repoMeta, data.files, (progress) => {
            self.postMessage({ type: 'progress', progress });
        }, data.options || {});
        self.postMessage({ type: 'result', result });
    } catch (error) { reportWorkerError(error); }
};
