import { describe, expect, it } from 'vitest';
import { Parser } from '../parser.js';

describe('parser fallback quality and complexity estimates', () => {
    it('does not extract Java records or constructors as ordinary methods', () => {
        const source = [
            'package demo;',
            'public record RoleSeed(String name) {}',
            'public class BadRequestException extends RuntimeException {',
            '  public BadRequestException(String message) { super(message); }',
            '  public void doWork() { System.out.println("ok"); }',
            '}',
        ].join('\n');
        const functions = Parser.extract(source, 'src/BadRequestException.java', {});
        expect(functions.map((item) => item.name)).not.toContain('RoleSeed');
        expect(functions.map((item) => item.name)).not.toContain('BadRequestException');
        expect(functions.map((item) => item.name)).toContain('doWork');
    });
    it('does not count branches inside comments or ordinary strings', () => {
        const source = [
            '// if (fake) for (;;) { while (false) {} }',
            'const note = "if (notCode) { for (;;) {} }";',
            'function real(value) {',
            '  if (value) return 1;',
            '}',
        ].join('\n');
        expect(Parser.calcComplexity(source, 'src/example.js')).toMatchObject({
            score: 2,
            decisionPoints: 1,
            method: 'heuristic-branch-count',
        });
    });

    it('counts code inside template interpolations but ignores template text', () => {
        const source = 'const label = `if (notCode) ${ready ? "yes" : "no"}`;';
        expect(Parser.calcComplexity(source, 'src/template.js').score).toBe(2);
    });

    it('does not count Python branches inside comments and triple-quoted strings', () => {
        const source = [
            '"""',
            'if fake:',
            '    for item in hidden: pass',
            '"""',
            '# while fake: pass',
            'if actual:',
            '    return True',
        ].join('\n');
        expect(Parser.calcComplexity(source, 'src/example.py')).toMatchObject({ score: 2, decisionPoints: 1 });
    });

    it('uses actual brace-balanced end lines in JS regex fallback and ignores fake definitions', () => {
        const source = [
            '// function fake() { if (x) {} }',
            'const note = "function decoy() { return false; }";',
            'function real(value) {',
            '  const shape = { nested: true };',
            '  if (value) { return shape.nested; }',
            '  return false;',
            '}',
            'function later() { return true; }',
        ].join('\n');
        const diagnostics = {};
        const functions = Parser.extract(source, 'src/fallback.js', diagnostics);
        expect(diagnostics.mode).toBe('regex-fallback');
        expect(functions.map((fn) => fn.name)).toEqual(['real', 'later']);
        expect(functions[0]).toMatchObject({ line: 3, endLine: 7 });
        expect(functions[1]).toMatchObject({ line: 8, endLine: 8 });
    });

    it('extracts Python definitions outside comments/docstrings and records end lines', () => {
        const source = [
            '"""',
            'def fake(): pass',
            'class Fake: pass',
            '"""',
            '# def also_fake(): pass',
            'def real(value):',
            '    if value:',
            '        return True',
            '    return False',
            '',
            'def later():',
            '    return True',
        ].join('\n');
        const functions = Parser.extract(source, 'src/example.py', {});
        expect(functions.map((fn) => fn.name)).toEqual(['real', 'later']);
        expect(functions[0]).toMatchObject({ line: 6, endLine: 9 });
        expect(functions[1]).toMatchObject({ line: 11, endLine: 12 });
    });

    it('does not report a hardcoded secret found only in a JS comment', () => {
        const commentsOnly = Parser.detectSecurity([{
            name: 'safe.js', path: 'src/safe.js',
            content: "// password = 'superSecretValue'\n/* token = 'anotherSecretValue' */\nconst ok = true;",
        }]);
        expect(commentsOnly.some((finding) => finding.title === 'Hardcoded Secret')).toBe(false);

        const realCode = Parser.detectSecurity([{
            name: 'unsafe.js', path: 'src/unsafe.js',
            content: "const password = 'superSecretValue';",
        }]);
        expect(realCode.some((finding) => finding.title === 'Hardcoded Secret')).toBe(true);
    });
});
