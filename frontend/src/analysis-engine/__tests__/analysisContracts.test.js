import { describe, expect, it } from 'vitest';
import { buildAnalysisCoverage, buildHealthScoreDetails, makeEvidenceEdge, normalizeFinding } from '../analysisContracts.js';

describe('analysis contracts', () => {
    it('marks repository coverage partial if a file analyzer failed', () => {
        const result = buildAnalysisCoverage({
            files: [{ path: 'src/A.java' }, { path: 'src/B.java' }],
            fileStatuses: [
                { path: 'src/A.java', language: 'java', extraction: 'complete', complexity: 'complete' },
                { path: 'src/B.java', language: 'java', extraction: 'failed', complexity: 'unknown', errors: ['parser failed'] },
            ],
            stageStatuses: { extraction: 'complete', security: 'complete' },
        });
        expect(result.status).toBe('partial');
        expect(result.files.extractionFailed).toBe(1);
        expect(result.failedFiles).toBe(1);
    });

    it('does not present unknown stages as complete', () => {
        const result = buildAnalysisCoverage({
            files: [],
            stageStatuses: { security: 'unknown', architecture: 'skipped' },
        });
        expect(result.status).toBe('partial');
        expect(result.stages.security.status).toBe('unknown');
        expect(result.skippedStages).toBe(1);
    });

    it('treats unsupported analysis as incomplete rather than clean', () => {
        const result = buildAnalysisCoverage({
            files: [{ path: 'src/Unknown.xyz' }],
            fileStatuses: [{ path: 'src/Unknown.xyz', language: 'other', extraction: 'unsupported', complexity: 'skipped' }],
            stageStatuses: { parser: 'unsupported' },
        });
        expect(result.status).toBe('partial');
        expect(result.unsupportedFiles).toBe(1);
        expect(result.unsupportedStages).toBe(1);
    });

    it('normalizes findings while preserving original UI-specific fields', () => {
        const finding = normalizeFinding({
            title: 'High Complexity', file: 'src/app.js', line: 18,
            severity: 'HIGH', confidence: 'INFERENCE', confidenceReason: 'heuristic',
        }, 'quality', 0);
        expect(finding.category).toBe('quality');
        expect(finding.severity).toBe('high');
        expect(finding.location).toEqual({ path: 'src/app.js', startLine: 18, endLine: 18 });
        expect(finding.evidenceAvailable).toBe(false);
        expect(finding.sourceLocationAvailable).toBe(true);
        expect(finding.title).toBe('High Complexity');
    });

    it('attaches a source excerpt only when the file and line can be matched', () => {
        const finding = normalizeFinding(
            { title: 'Possible issue', file: 'src/app.js', line: 2 },
            'security', 0,
            [{ path: 'src/app.js', content: 'const x = 1;\nrunUnsafe(x);' }],
        );
        expect(finding.evidence).toEqual([{
            type: 'source-line', path: 'src/app.js', startLine: 2, endLine: 2, excerpt: 'runUnsafe(x);',
        }]);
    });

    it('documents the health score as a heuristic with named penalties', () => {
        const details = buildHealthScoreDetails({
            stats: { files: 2, functions: 10, dead: 1, connections: 8 },
            issues: [{ title: 'Circular Dependencies' }, { title: 'Large Files' }],
            securityIssues: [{ severity: 'high' }],
            coverage: { status: 'partial' },
        });
        expect(details.kind).toBe('heuristic');
        expect(details.penalties.estimatedDeadFunctions).toBe(10);
        expect(details.penalties.circularDependencies).toBe(5);
        expect(details.coverageStatus).toBe('partial');
        expect(details.limitations.length).toBeGreaterThan(0);
    });

    it('keeps graph edge resolution and source line explicit', () => {
        expect(makeEvidenceEdge({
            source: 'A.java', target: 'B.java', type: 'import', line: 7,
            resolution: 'resolved', evidence: 'import com.example.B;',
        })).toMatchObject({ resolution: 'resolved', confidence: 'high', line: 7 });
    });
});

describe('parser strategy coverage', () => {
    it('counts regex fallback as heuristic coverage rather than a fully complete parse', () => {
        const result = buildAnalysisCoverage({
            files: [{ path: 'src/service.py' }, { path: 'src/app.ts' }, { path: 'README.md' }],
            fileStatuses: [
                { path: 'src/service.py', language: 'python', parserStrategy: 'python-regex', extraction: 'complete', complexity: 'complete' },
                { path: 'src/app.ts', language: 'typescript', parserStrategy: 'ast', extraction: 'complete', complexity: 'complete' },
                { path: 'README.md', language: 'other', parserStrategy: 'not-code', extraction: 'skipped', complexity: 'skipped' },
            ],
            stageStatuses: { extraction: 'partial', complexity: 'complete' },
        });
        expect(result.status).toBe('partial');
        expect(result.parserCoverage.codeFiles).toBe(2);
        expect(result.parserCoverage.astPreferredFiles).toBe(1);
        expect(result.parserCoverage.heuristicParserFiles).toBe(1);
        expect(result.parserCoverage.nonCodeFilesSkipped).toBe(1);
        expect(result.statusReasons.some((reason) => reason.includes('heuristic/regex'))).toBe(true);
    });

    it('does not invent a health score when the score calculation failed', () => {
        const result = buildHealthScoreDetails({
            stats: { files: 2, functions: 2 },
            healthScore: { score: null, grade: null, status: 'unknown' },
        });
        expect(result.score).toBeNull();
        expect(result.grade).toBeNull();
        expect(result.kind).toBe('unavailable');
    });
});
