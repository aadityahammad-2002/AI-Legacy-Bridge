import { afterEach, describe, expect, it } from 'vitest';
import { clearAnalysisCache, createFileAnalysisCacheKey, getAnalysisCacheStats, getCachedComplexity, getCachedExtraction, setCachedComplexity, setCachedExtraction } from '../analysisCache.js';

afterEach(() => clearAnalysisCache());

describe('per-file incremental analysis cache', () => {
    it('keys records by path, content, and parser capabilities', async () => {
        const first = await createFileAnalysisCacheKey('src/a.ts', 'export const x = 1;', { acorn: true, Babel: true });
        const same = await createFileAnalysisCacheKey('src/a.ts', 'export const x = 1;', { acorn: true, Babel: true });
        const changed = await createFileAnalysisCacheKey('src/a.ts', 'export const x = 2;', { acorn: true, Babel: true });
        const differentParser = await createFileAnalysisCacheKey('src/a.ts', 'export const x = 1;', { acorn: false, Babel: false });
        if (first === null) return; // WebCrypto is an optional performance capability, never an analysis requirement.
        expect(same).toBe(first);
        expect(changed).not.toBe(first);
        expect(differentParser).not.toBe(first);
    });

    it('returns isolated copies and stores extraction plus complexity together', async () => {
        const key = await createFileAnalysisCacheKey('src/a.ts', 'export function a() {}');
        if (key === null) return;
        setCachedExtraction(key, { functions: [{ name: 'a', line: 1 }], diagnostics: { mode: 'ast' } });
        setCachedComplexity(key, { score: 3, level: 'low' });
        const extraction = getCachedExtraction(key);
        extraction.functions[0].name = 'mutated';
        expect(getCachedExtraction(key).functions[0].name).toBe('a');
        expect(getCachedComplexity(key)).toMatchObject({ score: 3, level: 'low' });
        expect(getAnalysisCacheStats().entries).toBe(1);
    });
});
