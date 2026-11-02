import { describe, expect, it } from 'vitest';
import { analyzeTestLinkage, isTestFile } from '../testLinkage.js';

describe('test linkage', () => {
    it('links test files to imported production files without claiming coverage', () => {
        const files = [
            { path: 'src/payment.ts', content: 'export function charge() {}' },
            { path: 'src/payment.test.ts', content: "import { charge } from './payment';" },
            { path: 'src/unused.test.ts', content: 'test(\'placeholder\', () => {});' },
        ];
        const result = analyzeTestLinkage(files, [
            { source: 'src/payment.test.ts', target: 'src/payment.ts', type: 'import', resolution: 'resolved', line: 1, evidence: "import { charge } from './payment';" },
        ]);
        expect(result.testFileCount).toBe(2);
        expect(result.bySource['src/payment.ts']).toEqual([
            expect.objectContaining({ testFile: 'src/payment.test.ts', relationship: 'imports', confidence: 'high' }),
        ]);
        expect(result.unlinkedTestFiles).toContain('src/unused.test.ts');
        expect(result.semantics).toContain('not test coverage');
    });

    it('uses filename convention only as a lower-confidence fallback', () => {
        const result = analyzeTestLinkage([
            { path: 'src/order.py', content: 'def submit(): pass' },
            { path: 'src/test_order.py', content: 'def test_submit(): pass' },
        ], []);
        expect(result.bySource['src/order.py']).toEqual([
            expect.objectContaining({ testFile: 'src/test_order.py', relationship: 'filename-convention', confidence: 'low' }),
        ]);
    });

    it('recognizes common JS, Python, and Java test paths', () => {
        expect(isTestFile('src/__tests__/thing.test.ts')).toBe(true);
        expect(isTestFile('service/test_user.py')).toBe(true);
        expect(isTestFile('src/test/java/com/acme/OrderTest.java')).toBe(true);
        expect(isTestFile('src/production.js')).toBe(false);
    });
});
