import { describe, expect, it } from 'vitest';
import { Parser } from '../parser.js';
import { detectAdvancedSecrets } from '../security.js';

const runSecurity = (path, content) => Parser.detectSecurity([{ name: path.split('/').pop(), path, content, isCode: true }]);

describe('security rules distinguish executable code from comments and string examples', () => {
    it('does not treat a nested password example inside a string as a hardcoded secret', () => {
        const findings = runSecurity('src/configExample.js', `const help = 'password: "correct # password=admin"';\nconst ok = true;`);
        expect(findings.some((item) => item.title === 'Hardcoded Secret')).toBe(false);
    });

    it('still detects a credential assignment in executable code with line evidence', () => {
        const findings = runSecurity('src/config.js', `const ready = true;\nconst password = 'real-looking-secret-value';`);
        expect(findings.find((item) => item.title === 'Hardcoded Secret')).toMatchObject({
            line: 2,
            confidence: 'INFERENCE',
        });
    });

    it('does not flag eval text in comments, strings, or the scanner itself', () => {
        const decoy = runSecurity('src/decoy.js', `// eval(userInput)\nconst example = "eval(userInput)";`);
        expect(decoy.some((item) => /Dynamic Code Execution|Function Constructor/.test(item.title))).toBe(false);
        const scanner = runSecurity('src/parser.js', `if (code.includes('eval(')) { return 'eval('; }`);
        expect(scanner.some((item) => /Dynamic Code Execution|Function Constructor/.test(item.title))).toBe(false);
    });

    it('reports an executable eval call with source location', () => {
        const findings = runSecurity('src/unsafe.js', `function run(input) {\n  return eval(input);\n}`);
        expect(findings.find((item) => item.title === 'Dynamic Code Execution')).toMatchObject({
            line: 2,
            confidence: 'INFERENCE',
        });
    });

    it('does not apply VBA-specific Application.Run rules to Java source', () => {
        const findings = runSecurity('src/LegacyBridgeApplication.java', `class App { String note = "Application.Run(\"macro\")"; }`);
        expect(findings.some((item) => item.title === 'Dynamic Code Execution')).toBe(false);
    });

    it('reports an HTML sink as a potential sink with evidence, not as proven exploitability', () => {
        const findings = runSecurity('src/Panel.jsx', `function Panel({ html }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}`);
        expect(findings.find((item) => item.title === 'Potential XSS Sink')).toMatchObject({
            line: 2,
            confidence: 'INFERENCE',
        });
    });

    it('does not report an HTML sink name that occurs only in a string', () => {
        const findings = runSecurity('src/Panel.js', `const docs = "dangerouslySetInnerHTML";`);
        expect(findings.some((item) => /XSS/.test(item.title))).toBe(false);
    });

    it('does not report SQL-looking text that exists only in a string', () => {
        const findings = runSecurity('src/docsExample.js', `const sample = "db.query('SELECT * FROM users WHERE id=' + input)";`);
        expect(findings.some((item) => /SQL Injection/.test(item.title))).toBe(false);
    });

    it('reports dynamic SQL construction as a potential risk with evidence', () => {
        const findings = runSecurity('src/repository.js', `function load(id) {
  return db.query('SELECT * FROM users WHERE id=' + id);
}`);
        expect(findings.find((item) => item.title === 'Potential SQL Injection Risk')).toMatchObject({
            line: 2,
            confidence: 'INFERENCE',
        });
    });

    it('does not report VBA syntax patterns in JavaScript strings', () => {
        const findings = runSecurity('src/help.js', `const docs = "On Error Resume Next; Shell(\"cmd.exe\")";`);
        expect(findings.some((item) => /Shell Command Execution|Excessive Error Suppression|WScript\.Shell/.test(item.title))).toBe(false);
    });
});

describe('advanced secret detection avoids comments, test fixtures, and obvious placeholders', () => {
    it('ignores commented secrets and benchmark fixtures', () => {
        const findings = detectAdvancedSecrets([
            { path: 'src/example.js', content: `// const key = "AKIA1234567890ABCDEF";\nconst safe = true;` },
            { path: 'src/analysis-engine/benchmarks/run-regression.mjs', content: `const key = "AKIA1234567890ABCDEF";` },
        ]);
        expect(findings).toEqual([]);
    });

    it('does not report an obvious sample connection string but detects a non-placeholder candidate', () => {
        const findings = detectAdvancedSecrets([
            { path: 'src/Settings.jsx', content: `const placeholder = "postgres://user:password@host:5432/dbname";` },
            { path: 'src/config.js', content: `const DATABASE_URL = "postgres://alice:uniqueSecret@db.internal:5432/app";` },
        ]);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'src/config.js',
            title: 'Hardcoded Secret: Credentials in Connection String',
            line: 1,
            confidence: 'INFERENCE',
        });
    });

    it('reports an AWS key-shaped literal outside a comment', () => {
        const findings = detectAdvancedSecrets([
            { path: 'src/cloud.js', content: `const AWS_ACCESS_KEY = "AKIA1234567890ABCDEF";` },
        ]);
        expect(findings.some((item) => item.title === 'Hardcoded Secret: AWS Access Key')).toBe(true);
    });
});
