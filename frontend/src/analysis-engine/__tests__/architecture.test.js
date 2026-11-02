import { describe, expect, it } from 'vitest';
import { computeDependencyLayerViolations, computeModuleBoundaries } from '../architecture.js';

describe('module dependency architecture', () => {
    it('detects layer direction from explicit file imports even when there is no known call edge', () => {
        const files = [
            { path: 'src/repository/UserRepository.java', layer: 'repository' },
            { path: 'src/controller/UserController.java', layer: 'controller' },
        ];
        const violations = computeDependencyLayerViolations(files, [
            { source: 'src/repository/UserRepository.java', target: 'src/controller/UserController.java', type: 'import', resolution: 'resolved', line: 4, evidence: 'import app.controller.UserController;' },
        ]);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ from: 'src/repository/UserRepository.java', to: 'src/controller/UserController.java', relation: 'imports', line: 4, confidence: 'medium' });
    });

    it('does not flag ambiguous dependency edges as confirmed architecture violations', () => {
        const files = [
            { path: 'src/repository/UserRepository.java', layer: 'repository' },
            { path: 'src/controller/UserController.java', layer: 'controller' },
        ];
        expect(computeDependencyLayerViolations(files, [
            { source: 'src/repository/UserRepository.java', target: 'src/controller/UserController.java', type: 'import', resolution: 'ambiguous' },
        ])).toEqual([]);
    });

    it('keeps module boundary edges in importer-to-imported direction', () => {
        const result = computeModuleBoundaries({
            files: [{ path: 'src/orders/OrderService.ts' }, { path: 'src/payments/PaymentService.ts' }],
            dependencies: [{ source: 'src/orders/OrderService.ts', target: 'src/payments/PaymentService.ts', type: 'import', resolution: 'resolved' }],
        });
        expect(result.edges).toEqual([{ from: 'orders', to: 'payments', count: 1 }]);
    });
});
