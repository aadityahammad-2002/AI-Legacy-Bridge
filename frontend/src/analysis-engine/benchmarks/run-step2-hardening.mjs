import assert from 'node:assert/strict';
import { Parser } from '../parser.js';

const java = [
  'package demo;',
  'public record RoleSeed(String name) {}',
  'public class BadRequestException extends RuntimeException {',
  '  public BadRequestException(String message) { super(message); }',
  '  public void doWork() { System.out.println("ok"); }',
  '}',
].join('\n');
const javaSymbols = Parser.extract(java, 'src/BadRequestException.java', {}).map(fn => fn.name);
assert.deepEqual(javaSymbols, ['doWork'], 'Java constructors/records must not appear as methods');
const python = [
  '"""', 'def fake(): pass', 'class Fake: pass', '"""', '# def also_fake(): pass',
  'def real(value):', '    if value:', '        return True', '    return False', '',
  'def later():', '    return True',
].join('\n');
const pythonSymbols = Parser.extract(python, 'src/example.py', {});
assert.deepEqual(pythonSymbols.map(({name, line, endLine})=>({name,line,endLine})), [
  {name:'real',line:6,endLine:9}, {name:'later',line:11,endLine:12},
]);
const js = 'const label = `if (notCode) ${ready ? "yes" : "no"}`;';
assert.equal(Parser.calcComplexity(js, 'src/template.js').score, 2);
assert.equal(Parser.calcComplexity('// if (fake)\nconst note="if (ignored)";\nif (ok) run();', 'src/example.js').score, 2);
assert.equal(Parser.calcComplexity('const x = `if (notCode) ${ok ? { a: true } : { b: false }}`;', 'src/template.js').score, 2);
console.log('Step 2 hardening: 5 assertions PASS');
