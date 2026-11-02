import { reportWorkerError } from './workerClient.js';
self.onmessage = ({ data }) => {
    try {
        if (data.mode === 'serialize') self.postMessage({ type: 'result', result: JSON.stringify(data.payload, null, data.pretty ? 2 : 0) });
        else if (data.mode === 'parse') self.postMessage({ type: 'result', result: JSON.parse(data.json) });
        else throw new Error('Unsupported JSON operation');
    } catch (error) { reportWorkerError(error); }
};
