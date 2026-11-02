import { describe, expect, it } from 'vitest';
import { computeChangeImpact, computeFunctionImpact } from '../changeImpact.js';

describe('change impact estimation', () => {
    it('finds direct and transitive dependents without looping on cycles', () => {
        const result = computeChangeImpact('src/core.ts', [
            { source: 'src/service.ts', target: 'src/core.ts', type: 'import', resolution: 'resolved', line: 2 },
            { source: 'src/ui.ts', target: 'src/service.ts', type: 'import', resolution: 'resolved', line: 1 },
            { source: 'src/service.ts', target: 'src/ui.ts', type: 'import', resolution: 'resolved', line: 3 },
        ]);
        expect(result.directDependents.map((item) => item.path)).toEqual(['src/service.ts']);
        expect(result.transitiveDependents.map((item) => item.path)).toEqual(['src/ui.ts']);
        expect(result.affectedFiles).toHaveLength(2);
    });

    it('labels impact partial when unresolved or ambiguous imports exist', () => {
        const result = computeChangeImpact('src/core.ts', [
            { source: 'src/service.ts', target: 'src/core.ts', type: 'import', resolution: 'inferred' },
        ], {
            unresolvedLocalImports: [{ path: 'src/other.ts', line: 1, specifier: './missing' }],
            ambiguousImports: [],
            coverageStatus: 'partial',
        });
        expect(result.completeness).toBe('partial');
        expect(result.affectedFiles[0].confidence).toBe('medium');
        expect(result.uncertainty.notes.length).toBeGreaterThan(0);
    });

    it('does not count the changed file as its own dependent when an import cycle exists', () => {
        const result = computeChangeImpact('src/A.ts', [
            { source: 'src/A.ts', target: 'src/B.ts', type: 'import', resolution: 'resolved' },
            { source: 'src/B.ts', target: 'src/A.ts', type: 'import', resolution: 'resolved' },
        ]);
        expect(result.affectedFiles.map((item) => item.path)).toEqual(['src/B.ts']);
    });

    it('does not use explicitly unresolved edges to claim impact', () => {
        const result = computeChangeImpact('src/core.ts', [
            { source: 'src/guess.ts', target: 'src/core.ts', type: 'import', resolution: 'unresolved' },
        ]);
        expect(result.affectedFiles).toEqual([]);
    });

    it('returns an empty, clearly bounded impact list for isolated files', () => {
        const result = computeChangeImpact('src/isolated.ts', []);
        expect(result.affectedFiles).toEqual([]);
        expect(result.completeness).toBe('based-on-known-edges');
    });


    it('keeps ambiguous targets as possible impact rather than confirmed dependents', () => {
        const result = computeChangeImpact('src/core.ts', [
            { source: 'src/possible.ts', target: 'src/core.ts', type: 'import', resolution: 'ambiguous', line: 4 },
            { source: 'src/confirmed.ts', target: 'src/core.ts', type: 'import', resolution: 'resolved', line: 8 },
        ]);
        expect(result.directDependents.map((item) => item.path)).toEqual(['src/confirmed.ts']);
        expect(result.possibleDirectDependents).toEqual([
            expect.objectContaining({ path: 'src/possible.ts', relationship: 'possible-direct-dependent', confidence: 'low' }),
        ]);
    });
});


describe('function-level change impact estimation', () => {
    const changed = 'src/payment.ts|10|charge';
    const checkout = 'src/order.ts|4|checkout';
    const handler = 'src/api.ts|7|handleCheckout';

    it('finds direct and transitive callers through resolved function edges', () => {
        const result = computeFunctionImpact(changed, [
            {
                callerFunctionKey: checkout, callerFunctionName: 'checkout', callerFile: 'src/order.ts', callerStartLine: 4,
                calleeFunctionKey: changed, calleeFunctionName: 'charge', calleeFile: 'src/payment.ts', calleeStartLine: 10,
                callSiteLine: 8, resolution: 'resolved', confidence: 'medium', attribution: 'heuristic-function-line-range',
            },
            {
                callerFunctionKey: handler, callerFunctionName: 'handleCheckout', callerFile: 'src/api.ts', callerStartLine: 7,
                calleeFunctionKey: checkout, calleeFunctionName: 'checkout', calleeFile: 'src/order.ts', calleeStartLine: 4,
                callSiteLine: 12, resolution: 'resolved', confidence: 'medium', attribution: 'heuristic-function-line-range',
            },
        ]);
        expect(result.directCallers.map((item) => item.name)).toEqual(['checkout']);
        expect(result.transitiveCallers.map((item) => item.name)).toEqual(['handleCheckout']);
        expect(result.completeness).toBe('based-on-known-function-edges');
    });

    it('excludes the changed function itself and marks incomplete resolution', () => {
        const result = computeFunctionImpact(changed, [
            {
                callerFunctionKey: checkout, callerFunctionName: 'checkout', callerFile: 'src/order.ts', callerStartLine: 4,
                calleeFunctionKey: changed, calleeFunctionName: 'charge', calleeFile: 'src/payment.ts', calleeStartLine: 10,
                resolution: 'resolved', confidence: 'medium',
            },
            {
                callerFunctionKey: changed, callerFunctionName: 'charge', callerFile: 'src/payment.ts', callerStartLine: 10,
                calleeFunctionKey: changed, calleeFunctionName: 'charge', calleeFile: 'src/payment.ts', calleeStartLine: 10,
                resolution: 'resolved', confidence: 'medium',
            },
        ], { unresolvedCallCount: 2, unattributedFunctionCallSiteCount: 1 });
        expect(result.affectedFunctions.map((item) => item.functionKey)).toEqual([checkout]);
        expect(result.completeness).toBe('partial');
        expect(result.uncertainty.unresolvedCallCount).toBe(2);
        expect(result.uncertainty.unattributedFunctionCallSiteCount).toBe(1);
    });
});
