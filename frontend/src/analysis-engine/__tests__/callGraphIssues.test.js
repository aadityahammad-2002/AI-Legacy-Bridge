import { describe, expect, it } from 'vitest';
import { buildIssues } from '../callGraph.js';

describe('file-level issue metrics use file dependencies', () => {
    it('detects mutual file dependencies without requiring function-call edges', () => {
        const issues = buildIssues({
            files: [{ path: 'A.ts', functionCount: 1 }, { path: 'B.ts', functionCount: 1 }],
            connections: [], fnStats: {}, duplicates: [], layerViolations: [],
            dependencies: [
                { source: 'A.ts', target: 'B.ts', type: 'import', resolution: 'resolved' },
                { source: 'B.ts', target: 'A.ts', type: 'import', resolution: 'resolved' },
            ],
        });
        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: '1 Circular Dependencies' }),
        ]));
    });

    it('does not promote inferred or ambiguous edges to confirmed cycle findings', () => {
        const issues = buildIssues({
            files: [{ path: 'A.ts', functionCount: 1 }, { path: 'B.ts', functionCount: 1 }],
            connections: [], fnStats: {}, duplicates: [], layerViolations: [],
            dependencies: [
                { source: 'A.ts', target: 'B.ts', type: 'same-package', resolution: 'inferred' },
                { source: 'B.ts', target: 'A.ts', type: 'import', resolution: 'ambiguous' },
            ],
        });
        expect(issues.some((issue) => issue.title.includes('Circular Dependencies'))).toBe(false);
    });

    it('counts distinct importing files rather than function call counts for coupling', () => {
        const dependencies = Array.from({ length: 9 }, (_, index) => ({
            source: `src/consumer${index}.ts`, target: 'src/shared.ts', type: 'import', resolution: 'resolved',
        }));
        const issues = buildIssues({
            files: [{ path: 'src/shared.ts', functionCount: 1 }], connections: [], fnStats: {}, duplicates: [], layerViolations: [], dependencies,
        });
        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                title: '1 Highly Coupled',
                items: [expect.objectContaining({ file: 'src/shared.ts', name: 'shared.ts (9 importing files)' })],
            }),
        ]));
    });
});
