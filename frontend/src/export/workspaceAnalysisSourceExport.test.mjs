import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectRepositorySourceFiles, toWorkspaceAnalysisSourceJson } from './workspaceAnalysisSourceExport.js';

let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS', name); }
const baseline = {
    repository: { name: 'test-repository', source: 'zip' },
    engineVersion: '8.2.11',
    files: [
        { path: 'src/a.js', language: 'javascript', loc: 2, content: 'old parser snapshot' },
        { path: 'src/b.py', language: 'python', loc: 2 },
    ],
    fileContents: {
        'src/a.js': 'const text = "💻";\nconsole.log(text);\n',
        'src/b.py': 'def f():\n    return "line\\nend"\n',
    },
    functions: [{ name: 'f', file: 'src/b.py', line: 1 }],
};
const before = JSON.stringify(baseline);
const json = toWorkspaceAnalysisSourceJson(baseline, baseline.repository, '2026-11-03T10:00:00.000Z');
const doc = JSON.parse(json);
check('schema v2 with source flag and legacy export format', () => {
    assert.equal(doc.exportFormat, 'ai-legacy-bridge-analysis-json');
    assert.equal(doc.exportSchemaVersion, 2);
    assert.equal(doc.sourceCodeIncluded, true);
    assert.equal(doc.sourceScope, 'loaded-repository-text-files');
    assert.equal(doc.sourceFileCount, 2);
});
check('full byte-for-byte code preserved, including Unicode and trailing newline', () => {
    assert.equal(doc.sourceFiles[0].path, 'src/a.js');
    assert.equal(doc.sourceFiles[0].content, baseline.fileContents['src/a.js']);
    assert.equal(doc.sourceFiles[1].content, baseline.fileContents['src/b.py']);
});
check('authoritative original source preferred over extracted-file copy', () => {
    assert.notEqual(doc.sourceFiles[0].content, baseline.files[0].content);
});
check('analysis metadata still present, no duplicate raw code in analysis', () => {
    assert.equal(doc.analysis.engineVersion, '8.2.11');
    assert.deepEqual(doc.analysis.functions, baseline.functions);
    assert(!Object.hasOwn(doc.analysis, 'fileContents'));
    assert(!Object.hasOwn(doc.analysis.files[0], 'content'));
    assert(!Object.hasOwn(doc.analysis.files[1], 'content'));
});
check('input analysis object not mutated', () => assert.equal(JSON.stringify(baseline), before));
check('falls back to source in analysis.files after backend re-open', () => {
    const input = { files: [{path: 'app/Hello.java', content: 'class Hello {}'}] };
    assert.deepEqual(collectRepositorySourceFiles(input), [{path: 'app/Hello.java', content: 'class Hello {}'}]);
});
check('accepts and canonicalizes Windows paths', () => {
    const input = {files: [{path: 'a\\b.js', content: 'var a = 1'}]};
    assert.deepEqual(collectRepositorySourceFiles(input), [{path: 'a/b.js', content: 'var a = 1'}]);
});
check('does not silently export when raw source is missing', () => {
    assert.throws(() => toWorkspaceAnalysisSourceJson({files:[{path:'a.js'}]}), /unavailable/);
    assert.throws(() => toWorkspaceAnalysisSourceJson({files:[{path:'a.js'}, {path:'b.js'}], fileContents:{'a.js': 'ok'}}), /missing for 1/);
});
check('rejects unsafe paths', () => {
    for (const bad of ['/etc/passwd', '../secret.env', 'C:\\etc\\passwd', 'one/../two']) {
        assert.throws(() => collectRepositorySourceFiles({fileContents:{[bad]:'secret'}}), /Unsafe/);
    }
});
check('deterministic sorted file list, no duplicated paths', () => {
    const input = {files:[{path:'z.js',content:'z'}, {path:'a.js',content:'a'}],fileContents:{'a.js':'A'}};
    assert.deepEqual(collectRepositorySourceFiles(input),[{path:'a.js',content:'A'}, {path:'z.js',content:'z'}]);
});

// Optional real 82-section v8.2.11 fixture from previous user-generated exports.
const fixture = process.env.ANALYSIS_FIXTURE_PATH || fileURLToPath(new URL('../../../fixtures/YottaFlex_AI_FINAL_Submission-analysis.json', import.meta.url));
if (fs.existsSync(fixture)) {
    const oldDoc = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    const originalKeys = Object.keys(oldDoc.analysis);
    const result = {
        ...oldDoc.analysis,
        fileContents: Object.fromEntries(oldDoc.analysis.files.map(file => [file.path, `RAW_CONTENT_FOR:${file.path}\n`])),
    };
    const updated = JSON.parse(toWorkspaceAnalysisSourceJson(result, oldDoc.repository));
    check('real v8.2.11 export retains all 82 analysis sections', () => {
        assert.equal(originalKeys.length, 82);
        assert.deepEqual(Object.keys(updated.analysis), originalKeys);
        assert.deepEqual(updated.analysis, oldDoc.analysis);
        assert.equal(updated.sourceFiles.length, result.files.length);
    });
}
console.log(`ALL ${count} WORKSPACE SOURCE-EXPORT CHECKS PASSED`);
