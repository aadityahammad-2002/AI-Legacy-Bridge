/** Multi-language behavioral regressions: one positive declaration, one disguised
 * declaration in comments or strings, type extraction, and source-span checks.
 * These fixtures test scanner behavior, not real-world precision/recall. */
import assert from 'node:assert/strict';
import { Parser } from '../parser.js';
import { extractLoadedTreeSitterFunctions } from '../languageAst.js';
import { analyzeRepository } from '../orchestrator.js';
import { identifyCodeLanguage, extractLanguageFunctions, extractLanguageTypes, maskLanguageNonCode, SUPPORTED_CODE_LANGUAGES } from '../languageIntelligence.js';

const samples = [
    ['Python','a.py',`# def fake():\nclass Thing:\n    def real(self):\n        return 1\n`,'Thing.real','Thing'],
    ['JavaScript','a.js',`// function fake() {}\nclass Thing {}\nfunction real() { return 1; }\n`,'real','Thing'],
    ['TypeScript','a.ts',`// function fake() {}\ninterface Thing {}\nexport function real(): number { return 1; }\n`,'real','Thing'],
    ['Java','a.java',`// public int fake() {}\nclass Thing {\n    int real(int a) { return a; }\n}\n`,'real','Thing'],
    ['Go','a.go',`// func fake() {}\ntype Thing struct {}\nfunc real(a int) int { return a }\n`,'real','Thing'],
    ['Rust','a.rs',`// fn fake() {}\nstruct Thing {}\npub fn real(a: i32) -> i32 { a }\n`,'real','Thing'],
    ['Ruby','a.rb',`# def fake\nclass Thing\n  def real(a)\n    a\n  end\nend\n`,'real','Thing'],
    ['PHP','a.php',`// function fake() {}\nclass Thing {}\nfunction real($a) { return $a; }\n`,'real','Thing'],
    ['C','a.c',`// int fake() {}\nstruct Thing { int x; };\nint real(int a) { return a; }\n`,'real','Thing'],
    ['C++','a.cpp',`// int fake() {}\nclass Thing {};\nint real(int a) { return a; }\n`,'real','Thing'],
    ['C#','a.cs',`// public int fake() {}\nclass Thing {\n int real(int a) { return a; }\n}\n`,'real','Thing'],
    ['Swift','a.swift',`// func fake() {}\nstruct Thing {}\nfunc real(_ a: Int) -> Int { return a }\n`,'real','Thing'],
    ['Kotlin','a.kt',`// fun fake() {}\nclass Thing {}\nfun real(a: Int): Int { return a }\n`,'real','Thing'],
    ['Scala','a.scala',`// def fake() = 1\nclass Thing {}\ndef real(a: Int) = a\n`,'real','Thing'],
    ['Clojure','a.clj',`; (defn fake [] 1)\n(defrecord Thing [x])\n(defn real [a] a)\n`,'real','Thing'],
    ['Elixir','a.ex',`# def fake(), do: 1\ndefmodule Thing do\n  def real(a) do\n    a\n  end\nend\n`,'real','Thing'],
    ['Erlang','a.erl',`% fake() -> 1.\n-record(thing, {x}).\nreal(A) -> A.\n`,'real',null],
    ['Haskell','a.hs',`-- fake x = x\ndata Thing = Thing Int\nreal x = x\n`,'real','Thing'],
    ['Lua','a.lua',`-- function fake() end\nlocal Thing = {}\nfunction real(a)\n  return a\nend\n`,'real','Thing'],
    ['R','a.r',`# fake <- function(a) a\nreal <- function(a) {\n  a\n}\n`,'real',null],
    ['Julia','a.jl',`# function fake() end\nstruct Thing end\nfunction real(a)\n  return a\nend\n`,'real','Thing'],
    ['Dart','a.dart',`// int fake() => 1;\nclass Thing {}\nint real(int a) { return a; }\n`,'real','Thing'],
    ['Elm','a.elm',`-- fake x = x\ntype Thing = Thing Int\nreal x = x\n`,'real','Thing'],
    ['F#','a.fs',`// let fake x = x\ntype Thing = { x: int }\nlet real x = x\n`,'real','Thing'],
    ['OCaml','a.ml',`(* let fake x = x *)\ntype thing = Thing\nlet real x = x\n`,'real','thing'],
    ['Perl','a.pl',`# sub fake {}\npackage Thing;\nsub real { return 1; }\n`,'real','Thing'],
    ['Shell','a.sh',`# fake() { true; }\nreal() {\n  echo ok\n}\n`,'real',null],
    ['PowerShell','a.ps1',`# function fake {}\nclass Thing {}\nfunction real { 1 }\n`,'real','Thing'],
    ['Groovy','a.groovy',`// def fake() {}\nclass Thing {}\ndef real(a) { a }\n`,'real','Thing'],
    ['VBA','a.vba',`' Sub fake()\nPublic Type Thing\n x As Integer\nEnd Type\nPublic Sub real()\nEnd Sub\n`,'real','Thing'],
];
assert.equal(SUPPORTED_CODE_LANGUAGES.length, 30);
for (const [expectedLanguage,path,content,expectedFunction,expectedType] of samples) {
    assert.equal(identifyCodeLanguage(path), expectedLanguage, path);
    const discovered = Parser.extract(content, path, {});
    const names = discovered.map((fn) => fn.name);
    assert.ok(names.includes(expectedFunction), `${expectedLanguage}: ${path}: missing ${expectedFunction} from ${JSON.stringify(names)}`);
    assert.ok(!names.includes('fake'), `${expectedLanguage}: invented fake declaration in a comment`);
    assert.ok(!discovered.some((entry) => entry.endLine < entry.line), `${expectedLanguage}: inverted function range`);
    if (expectedType) {
        const types = extractLanguageTypes(content, path).map((entry) => entry.name);
        assert.ok(types.includes(expectedType), `${expectedLanguage}: missing type ${expectedType} from ${types}`);
    }
    const masked = maskLanguageNonCode(content, expectedLanguage);
    assert.equal(masked.split('\n').length, content.split('\n').length);
    assert.equal(masked.length, content.length, `offsets not preserved for ${path}`);
}
// Declarations fabricated in strings or line comments must not be accepted.
for (const [path, content] of [
    ['a.java', 'String s = "public int fake() { return 1; }";'],
    ['a.rs', 'let code = "pub fn fake() { }";'],
    ['a.rb', 'text = "def fake"'],
    ['a.ps1', '$x = "function fake { }"'],
    ['a.sh', 'text="fake() { echo x; }"'],
]) assert.ok(!extractLanguageFunctions(content, path).functions.some((fn) => fn.name === 'fake'));

// Optional syntax-tree integration is exercised with a deterministic parser
// stub. This does not prove that remote grammars initialize in a browser.
const javaSource = 'public int verified() { return 1; }';
const astName = { type: 'identifier', startIndex: 11, endIndex: 19, text: 'verified', namedChildren: [] };
const astMethod = {
    type: 'method_declaration', startIndex: 0, endIndex: javaSource.length,
    startPosition: { row: 0 }, endPosition: { row: 0 }, namedChildren: [astName],
    childForFieldName(field) { return field === 'name' ? astName : null; },
};
const syntaxRoot = { type: 'program', namedChildren: [astMethod], hasError: () => false };
const mockParser = { parse: () => ({ rootNode: syntaxRoot }) };
const result = extractLoadedTreeSitterFunctions(javaSource, 'sample.java', mockParser);
assert.equal(result.status, 'complete');
assert.equal(result.functions[0].name, 'verified');
assert.equal(result.functions[0].endLineConfidence, 'ast');
const oldJavaParser = Parser._tsParsers.java;
try {
    Parser._tsParsers.java = mockParser;
    const diagnostics = {};
    const astSymbols = Parser.extract(javaSource, 'sample.java', diagnostics);
    assert.equal(diagnostics.mode, 'tree-sitter-ast');
    assert.equal(astSymbols[0].name, 'verified');
    Parser._tsParsers.java = { parse: () => ({ rootNode: { ...syntaxRoot, hasError: () => true } }) };
    const fallbackDiagnostics = {};
    Parser.extract(javaSource, 'sample.java', fallbackDiagnostics);
    assert.equal(fallbackDiagnostics.mode, 'language-aware-lexical');
    assert.equal(fallbackDiagnostics.astFallback, 'syntax-errors');
} finally {
    if (oldJavaParser) Parser._tsParsers.java = oldJavaParser;
    else delete Parser._tsParsers.java;
}
// A Kotlin expression-bodied function must never borrow a following braced
// declaration's body as its own call-graph evidence.
const kotlin = extractLanguageFunctions('fun compact() = 3\nfun expanded() {\n return 4\n}\n', 'a.kt');
assert.equal(kotlin.functions.find((f) => f.name === 'compact').endLine, 1);
assert.equal(kotlin.functions.find((f) => f.name === 'expanded').endLine, 4);

// End-to-end: language summaries are based on actual modes used per file, not
// the mere existence of a Tree-sitter grammar config.
const multi = await analyzeRepository({ name: 'multilang-smoke' }, samples.map(([,path,content]) => ({path,content})));
assert.match(multi.engineVersion, /^8\./);
assert.equal(multi.analysisCoverage.languageDepth.supportedLanguages, 30);
assert.equal(multi.analysisCoverage.languageDepth.parsedLanguages, 30);
assert.equal(multi.analysisCoverage.languageDepth.languages.R.lexicalFiles, 1);
assert.equal(multi.analysisCoverage.languageDepth.languages.PowerShell.lexicalFiles, 1);
assert.ok(multi.functions.some((fn) => fn.name === 'real' && fn.file === 'a.rs'));
assert.ok(multi.classes.some((entry) => entry.name === 'Thing' && entry.file === 'a.hs'));
console.log(JSON.stringify({ status: 'passed', languages: samples.map(([name]) => name), count: samples.length, endToEnd: {
    symbols: multi.functions.length, types: multi.classes.length, languageDepth: multi.analysisCoverage.languageDepth.parsedLanguages,
}, disclaimer: 'Fixtures prove extraction and offset preservation only; no compiler-grade or cross-repository accuracy claim.' }, null, 2));
