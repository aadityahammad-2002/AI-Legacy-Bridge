/** Public ZIP-source facade: modern browsers inflate source files off-thread. */
import ZipWorker from '../workers/zip.worker.js?worker';
import { runWorker } from '../workers/workerClient.js';

// Lazy legacy route: never preload JSZip/parser into the normal UI bundle.
export async function readZipRepositoryMainThread(zipFile, onProgress) {
    const { readZipRepositoryMainThread: read } = await import('./zipCore.js');
    return read(zipFile, onProgress);
}

export async function readZipRepository(zipFile, onProgress, { signal } = {}) {
    if (typeof Worker === 'undefined') return readZipRepositoryMainThread(zipFile, onProgress);
    return runWorker(ZipWorker, { zipFile }, { onProgress, signal });
}
