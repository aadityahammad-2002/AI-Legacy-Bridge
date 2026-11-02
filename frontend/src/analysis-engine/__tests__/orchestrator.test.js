import { describe, expect, it } from 'vitest';
import { analyzeRepository, extractClasses } from '../orchestrator.js';

describe('analysis orchestrator contracts', () => {
    it('reports skipped documentation separately from code and exposes parser mode', async () => {
        const result = await analyzeRepository({ name: 'fixture', source: 'local' }, [
            { path: './src/main.js', content: "import { run } from './service.js';\nexport function start() { return run(); }" },
            { path: 'src/service.js', content: 'export function run() { return true; }' },
            { path: 'README.md', content: '# Fixture\nDocument only.' },
        ]);
        expect(result.analysisInput).toMatchObject({ discoveredFiles: 3, codeFiles: 2, nonCodeFiles: 1 });
        expect(result.analysisCoverage.files.nonCodeFilesSkipped).toBe(1);
        expect(result.analysisCoverage.parserCoverage.heuristicParserFiles).toBeGreaterThanOrEqual(0);
        expect(result.analysisCoverage.parserCoverage.byLanguage.javascript).toMatchObject({ files: 2, codeFiles: 2, extractionCompleted: 2 });
        expect(result.analysisCoverage.dependencyResolution).toHaveProperty('edgeResolutionPct');
        expect(result.analysisCoverage.callGraph).toHaveProperty('resolutionPct');
        expect(result.analysisCoverage.functionComplexity).toMatchObject({ status: 'complete', discoveredFunctions: 2, analyzedFunctions: 2, coveragePct: 100 });
        expect(result.analysisCoverage.perFile.find((file) => file.path === 'README.md')).toMatchObject({
            parserStrategy: 'not-code', extraction: { status: 'skipped' }, complexity: { status: 'skipped' },
        });
        expect(result.dependencies).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'src/main.js', target: 'src/service.js', resolution: 'resolved' }),
        ]));
    });

    it('reports function-level complexity from the full source span instead of the truncated display snippet', async () => {
        const lines = [
            'export function longBranch(input) {',
            ...Array.from({ length: 16 }, (_, index) => `  const value${index} = ${index};`),
            '  if (input) return true;',
            '  return false;',
            '}',
        ];
        const result = await analyzeRepository({ name: 'complexity-fixture', source: 'local' }, [
            { path: 'src/long.ts', content: lines.join('\n') },
        ]);
        expect(result.functions[0].code).not.toContain('if (input)');
        expect(result.functionComplexity.topComplexFunctions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'longBranch', file: 'src/long.ts', score: 2, endLine: lines.length }),
        ]));
        expect(result.functionComplexity.semantics).toContain('not compiler-grade cyclomatic complexity');
    });

    it('finds JVM type declarations without false positives in comments or strings', () => {
        const classes = extractClasses(`package com.example;
/* class CommentFake {} */
String text = "class StringFake {}";
@Entity
public class UserEntity { }
public
class OrderService { }`, 'src/UserEntity.java');
        expect(classes.map((item) => item.name)).toEqual(['UserEntity', 'OrderService']);
        expect(classes[0]).toMatchObject({ package: 'com.example', line: 5, annotations: ['Entity'] });
        expect(classes[1].line).toBe(7);
    });

    it('rejects unsafe repository paths before beginning analysis', async () => {
        await expect(analyzeRepository({ name: 'fixture', source: 'local' }, [
            { path: '../outside.js', content: 'export const x = 1;' },
        ])).rejects.toThrow(/Unsafe repository-relative path/);
    });

    it('rejects duplicate paths after canonicalization', async () => {
        await expect(analyzeRepository({ name: 'fixture', source: 'local' }, [
            { path: 'src/a.js', content: 'export const a = 1;' },
            { path: './src/a.js', content: 'export const a = 2;' },
        ])).rejects.toThrow(/Duplicate repository path/);
    });
});
