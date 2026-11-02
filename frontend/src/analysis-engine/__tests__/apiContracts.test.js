import { describe, expect, it } from 'vitest';
import { analyzeApiContracts, discoverEndpoints } from '../api.js';
import { analyzeRepository } from '../orchestrator.js';

describe('frontend/backend API contract matching', () => {
    it('detects duplicated Spring class/method prefixes against a frontend call', () => {
        const files = [
            { path: 'backend/AttendanceController.java', content: '@RestController\n@RequestMapping("/api/attendance")\nclass AttendanceController {\n  @PostMapping("/api/attendance/check-in")\n  void checkIn() {}\n}' },
            { path: 'frontend/src/api.ts', content: "await fetch('/api/attendance/check-in', { method: 'POST' });" },
        ];
        const endpoints = discoverEndpoints(files);
        const result = analyzeApiContracts(files, endpoints);
        expect(result).toMatchObject({ status: 'mismatches-found', clientCalls: 1, mismatchCount: 1, unknownCalls: 0 });
        expect(result.findings[0]).toMatchObject({
            ruleId: 'api-contract.route-mismatch',
            file: 'frontend/src/api.ts',
            line: 1,
        });
        expect(result.findings[0].message).toContain('/api/attendance/api/attendance/check-in');
    });

    it('does not flag a matching route and HTTP method', () => {
        const files = [
            { path: 'backend/AttendanceController.java', content: '@RestController\n@RequestMapping("/api/attendance")\nclass AttendanceController {\n  @PostMapping("/check-in")\n  void checkIn() {}\n}' },
            { path: 'frontend/src/api.ts', content: "await fetch('/api/attendance/check-in', { method: 'POST' });" },
        ];
        const result = analyzeApiContracts(files, discoverEndpoints(files));
        expect(result).toMatchObject({ status: 'matched', matchedCalls: 1, mismatchCount: 0 });
    });

    it('includes API contract findings in the integrated repository result', async () => {
        const result = await analyzeRepository({ name: 'api-contract-fixture', source: 'test' }, [
            { path: 'backend/AttendanceController.java', content: '@RestController\n@RequestMapping("/api/attendance")\nclass AttendanceController {\n  @PostMapping("/api/attendance/check-in")\n  void checkIn() {}\n}' },
            { path: 'frontend/src/api.ts', content: "await fetch('/api/attendance/check-in', { method: 'POST' });" },
        ]);
        expect(result.apiContractAnalysis.mismatchCount).toBe(1);
        expect(result.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ ruleId: 'api-contract.route-mismatch', category: 'api-contract' }),
        ]));
        expect(result.outputContractValidation.status).toBe('valid');
    });
});
