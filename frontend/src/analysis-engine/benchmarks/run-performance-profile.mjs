import { performance } from 'node:perf_hooks';
import { analyzeRepository } from '../orchestrator.js';

function makeFiles(count, runId) {
    const files = [];
    for (let index = 0; index < count; index++) {
        const importLine = index > 0 ? `import { fn${index - 1} } from './module-${index - 1}.js';\n` : '';
        const callLine = index > 0 ? `return fn${index - 1}() + ${index};` : 'return 1;';
        files.push({
            path: `synthetic-${runId}/module-${index}.js`,
            content: `${importLine}export function fn${index}() { ${callLine} }\n`,
        });
    }
    return files;
}

async function measureAnalysis(meta, files) {
    const memoryStart = process.memoryUsage();
    let peakHeapUsedBytes = memoryStart.heapUsed;
    let peakRssBytes = memoryStart.rss;
    const sampleMemory = () => {
        const usage = process.memoryUsage();
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
        peakRssBytes = Math.max(peakRssBytes, usage.rss);
    };
    const sampler = setInterval(sampleMemory, 5);
    const started = performance.now();
    try {
        const result = await analyzeRepository(meta, files);
        sampleMemory();
        return {
            result,
            durationMs: Math.round((performance.now() - started) * 100) / 100,
            heapStartBytes: memoryStart.heapUsed,
            heapEndBytes: process.memoryUsage().heapUsed,
            peakHeapUsedBytes,
            peakRssBytes,
        };
    } finally {
        clearInterval(sampler);
        sampleMemory();
    }
}

const profiles = [];
for (const count of [50, 200, 500]) {
    const files = makeFiles(count, `n${count}`);
    const meta = { name: `synthetic-profile-${count}`, source: 'benchmark' };
    const cold = await measureAnalysis(meta, files);
    const warm = await measureAnalysis(meta, files);
    const coldMs = cold.durationMs;
    const warmMs = warm.durationMs;
    const resolvedDependencies = cold.result.dependencies.filter((edge) => edge.resolution === 'resolved').length;
    profiles.push({
        files: count,
        coldMs,
        warmMs,
        speedupRatio: warmMs > 0 ? Math.round((coldMs / warmMs) * 100) / 100 : null,
        resolvedDependencies,
        expectedDependencies: count - 1,
        cacheHitsOnWarmRun: { extraction: warm.result.analysisCache.extractionHits, complexity: warm.result.analysisCache.complexityHits },
        coldMemory: { heapStartBytes: cold.heapStartBytes, heapEndBytes: cold.heapEndBytes, heapDeltaBytes: cold.heapEndBytes - cold.heapStartBytes, peakHeapUsedBytes: cold.peakHeapUsedBytes, peakRssBytes: cold.peakRssBytes },
        warmMemory: { heapStartBytes: warm.heapStartBytes, heapEndBytes: warm.heapEndBytes, heapDeltaBytes: warm.heapEndBytes - warm.heapStartBytes, peakHeapUsedBytes: warm.peakHeapUsedBytes, peakRssBytes: warm.peakRssBytes },
        coverageStatus: cold.result.analysisCoverage.status,
        assertion: resolvedDependencies === count - 1 ? 'passed' : 'failed',
    });
    if (resolvedDependencies !== count - 1) throw new Error(`Expected ${count - 1} resolved dependency edges for ${count} files, got ${resolvedDependencies}.`);
}
console.log(JSON.stringify({
    status: 'passed',
    benchmark: 'synthetic-scale-performance-profile',
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    profiles,
    limitations: [
        'Generated repositories measure selected synthetic dependency patterns and cache behavior, not arbitrary real-world scaling.',
        'Wall-clock and sampled peak memory vary by runtime, machine load and garbage collection; no SLA threshold is implied.',
        'Warm runs reuse in-memory caches only; they do not measure persisted cache or cross-process reuse.',
    ],
}, null, 2));
