/**
 * Small labelled regression corpus for common security-scanner false positives.
 * This is a deterministic fixture benchmark, not a real-world precision/recall study.
 */
import assert from 'node:assert/strict';
import { Parser } from '../parser.js';
import { detectAdvancedSecrets } from '../security.js';

const parserFindings = (path, content) => Parser.detectSecurity([{
    name: path.split('/').pop(), path, content, isCode: true,
}]);
const cases = [
    { id: 'secret-nested-in-string', expected: false, run: () => parserFindings('src/configExample.js', `const help = 'password: "correct # password=admin"';`).some((f) => f.title === 'Hardcoded Secret') },
    { id: 'secret-in-executable-assignment', expected: true, run: () => parserFindings('src/config.js', `const password = 'real-looking-secret-value';`).some((f) => f.title === 'Hardcoded Secret') },
    { id: 'eval-in-comment', expected: false, run: () => parserFindings('src/decoy.js', `// eval(userInput)`).some((f) => f.title === 'Dynamic Code Execution') },
    { id: 'eval-in-string', expected: false, run: () => parserFindings('src/decoy.js', `const example = "eval(userInput)";`).some((f) => f.title === 'Dynamic Code Execution') },
    { id: 'eval-in-executable-code', expected: true, run: () => parserFindings('src/unsafe.js', `function run(input) { return eval(input); }`).some((f) => f.title === 'Dynamic Code Execution') },
    { id: 'sql-looking-text-in-string', expected: false, run: () => parserFindings('src/docsExample.js', `const sample = "db.query('SELECT * FROM users WHERE id=' + input)";`).some((f) => /SQL Injection/.test(f.title)) },
    { id: 'sql-dynamic-concatenation', expected: true, run: () => parserFindings('src/repository.js', `function load(id) { return db.query('SELECT * FROM users WHERE id=' + id); }`).some((f) => f.title === 'Potential SQL Injection Risk') },
    { id: 'application-run-string-in-java', expected: false, run: () => parserFindings('src/App.java', `class App { String note = "Application.Run(\\"macro\\")"; }`).some((f) => f.title === 'Dynamic Code Execution') },
    { id: 'vba-shell-call', expected: true, run: () => parserFindings('legacy/Unsafe.bas', `Sub RunIt()\n Shell("cmd.exe")\nEnd Sub`).some((f) => f.title === 'Shell Command Execution') },
    { id: 'xss-sink-with-dynamic-value', expected: true, run: () => parserFindings('src/Panel.jsx', `return <div dangerouslySetInnerHTML={{ __html: html }} />;`).some((f) => f.title === 'Potential XSS Sink') },
    { id: 'xss-name-in-string', expected: false, run: () => parserFindings('src/Panel.js', `const docs = "dangerouslySetInnerHTML";`).some((f) => /XSS/.test(f.title)) },
    { id: 'static-html-literal', expected: false, run: () => parserFindings('src/Panel.jsx', `return <div dangerouslySetInnerHTML={{ __html: '<b>safe</b>' }} />;`).some((f) => /XSS/.test(f.title)) },
    { id: 'placeholder-connection-string', expected: false, run: () => detectAdvancedSecrets([{ path: 'src/Settings.jsx', content: `const placeholder = "postgres://user:password@host:5432/dbname";` }]).some((f) => f.title.includes('Connection String')) },
    { id: 'realistic-connection-string-candidate', expected: true, run: () => detectAdvancedSecrets([{ path: 'src/config.js', content: `const DATABASE_URL = "postgres://alice:uniqueSecret@db.internal:5432/app";` }]).some((f) => f.title.includes('Connection String')) },
    { id: 'aws-key-in-comment', expected: false, run: () => detectAdvancedSecrets([{ path: 'src/cloud.js', content: `// const key = "AKIA1234567890ABCDEF";` }]).some((f) => f.title === 'Hardcoded Secret: AWS Access Key') },
    { id: 'aws-key-in-code', expected: true, run: () => detectAdvancedSecrets([{ path: 'src/cloud.js', content: `const AWS_ACCESS_KEY = "AKIA1234567890ABCDEF";` }]).some((f) => f.title === 'Hardcoded Secret: AWS Access Key') },
];

const results = cases.map((testCase) => {
    const actual = Boolean(testCase.run());
    return { id: testCase.id, expected: testCase.expected, actual, passed: actual === testCase.expected };
});
const tp = results.filter((item) => item.expected && item.actual).length;
const fp = results.filter((item) => !item.expected && item.actual).length;
const fn = results.filter((item) => item.expected && !item.actual).length;
const tn = results.filter((item) => !item.expected && !item.actual).length;
const summary = {
    status: results.every((item) => item.passed) ? 'passed' : 'failed',
    benchmark: 'analysis-engine-security-accuracy-fixtures',
    fixtureCount: results.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    fixturePrecision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : null,
    fixtureRecall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : null,
    results,
    limitations: ['Synthetic labelled fixtures only; these metrics do not estimate accuracy on arbitrary real repositories.', 'Positive secret fixtures are shape candidates, not verified live credentials.', 'XSS sink detections do not prove exploitability.'],
};
console.log(JSON.stringify(summary, null, 2));
assert.equal(summary.status, 'passed', 'Security accuracy fixture regression failed.');
