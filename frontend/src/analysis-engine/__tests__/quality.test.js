import { describe, expect, it } from 'vitest';
import { checkNamingConventions, computeDocumentationCoverage, mineTodoComments, scanBasicA11y, scanConfigMisconfig } from '../quality.js';

describe('quality metrics preserve unknown/not-applicable states', () => {
    it('does not report zero documentation coverage when no functions were discovered', () => {
        expect(computeDocumentationCoverage([], [])).toMatchObject({
            totalFunctions: 0,
            documented: 0,
            coveragePct: null,
            status: 'not-applicable',
        });
    });
});

describe('quality scanners avoid common comment/string false positives', () => {
    it('reports TODO tags in comments but not ordinary source strings or identifiers', () => {
        const findings = mineTodoComments([{
            path: 'src/app.js',
            content: `const message = "TODO: only a string";\nconst TODO_FLAG = true;\n// TODO: wire retry handling\n/* FIXME: remove compatibility shim */`,
        }]);
        expect(findings.map((item) => item.tag)).toEqual(['TODO', 'FIXME']);
        expect(findings[0]).toMatchObject({ line: 3, text: 'wire retry handling' });
        expect(findings[1]).toMatchObject({ line: 4, text: 'remove compatibility shim */' });
    });

    it('does not report missing alt or invalid roles inside JSX/HTML comments', () => {
        const findings = scanBasicA11y([{
            path: 'src/App.jsx',
            content: `// <img src="commented.png">\n{/* <img src="jsx-commented.png"> <div role="not-a-role" /> */}\n<img src="real.png">\n<div role="not-a-role" />`,
        }]);
        expect(findings.map((item) => item.title)).toEqual(['Missing alt text', 'Invalid ARIA role: "not-a-role"']);
        expect(findings.every((item) => item.line >= 3)).toBe(true);
    });

    it('does not flag a full-line config comment as an active misconfiguration', () => {
        const findings = scanConfigMisconfig([{
            path: 'config/app.yml',
            content: '# DEBUG=true is an example only\nDEBUG: false\n# verify=False should not trigger',
        }]);
        expect(findings).toEqual([]);
    });
    it('does not match misconfiguration patterns that appear only in inline comments', () => {
        const findings = scanConfigMisconfig([
            { path: '.env', content: 'DEBUG=false # DEBUG=true is an example only\nPASSWORD=correct-horse # password=admin is an example' },
            { path: 'config/app.yml', content: 'debug: false # DEBUG=true\npassword: "correct # password=admin" # password=admin in comment' },
            { path: 'config/settings.jsonc', content: '{ "debug": false, // DEBUG=true\n  "password": "safe" /* password=admin */\n}' },
        ]);
        expect(findings).toEqual([]);
        const active = scanConfigMisconfig([
            { path: '.env', content: 'DEBUG=true\nPASSWORD=admin' },
            { path: 'config/one-line.json', content: '{\"debug\":true,\"password\":\"admin\",\"origin\":\"*\"}' },
        ]);
        expect(active.map((item) => item.title)).toEqual([
            'Debug mode enabled', 'Default/weak-looking credential',
            'Debug mode enabled', 'Wildcard CORS origin', 'Default/weak-looking credential',
        ]);
    });
});


describe('language- and symbol-aware naming conventions', () => {
    it('does not flag React page/layout components or Java type declarations and constructors', () => {
        const findings = checkNamingConventions([
            { name: 'AppLayout', file: 'frontend/src/AppLayout.jsx', line: 1, type: 'function', code: 'function AppLayout() { return <div />; }' },
            { name: 'PerformancePage', file: 'frontend/src/PerformancePage.jsx', line: 1, type: 'arrow', code: 'const PerformancePage = () => <div />;' },
            { name: 'RoleSeed', file: 'backend/RoleSeed.java', line: 1, type: 'function', code: 'record RoleSeed(String name) {}' },
            { name: 'BadRequestException', file: 'backend/BadRequestException.java', line: 2, type: 'method', className: 'BadRequestException', code: 'public BadRequestException(String message) { super(message); }' },
        ]);
        expect(findings).toEqual([]);
    });

    it('checks the leaf method name for Python and still detects genuine convention violations', () => {
        const findings = checkNamingConventions([
            { name: 'Worker.load_items', file: 'src/worker.py', line: 4, type: 'method', code: 'def load_items(self): pass' },
            { name: 'Bad_Name', file: 'src/worker.py', line: 9, type: 'function', code: 'def Bad_Name(): pass' },
            { name: 'DoWork', file: 'src/Worker.java', line: 12, type: 'method', className: 'Worker', code: 'void DoWork() {}' },
        ]);
        expect(findings.map((finding) => finding.name)).toEqual(['Bad_Name', 'DoWork']);
        expect(findings.every((finding) => finding.ruleId === 'naming.function-convention')).toBe(true);
    });
});
