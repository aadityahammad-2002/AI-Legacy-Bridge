/** Focused v8.2.5 regressions: method-span reconciliation and safe downloadable JSON.
 * Uses synthetic Java fixtures only; no actual repository code is bundled. */
import assert from 'node:assert/strict';
import { Parser } from '../parser.js';
import { toAnalysisJson, toDownloadableAnalysisJson } from '../reportFormats.js';
import { ENGINE_VERSION } from '../engineVersion.js';

const javaFile = 'backend/src/main/java/com/acme/service/ChatService.java';
const source = [
  'package com.acme.service;',
  'public class ChatService {',
  '  public String chat(String message, List<Map<String, String>> history, String context) {',
  '    String prompt = """',
  '      Illustrative O(n) and fake() calls in a Java text block',
  '      """;',
  '    try {',
  '      if (message.isBlank()) { return "empty"; }',
  '      return process(message);',
  '    } catch (Exception ex) {',
  '      return fallback();',
  '    }',
  '  }',
  '  public String callAiForText(String prompt) {',
  '    try {',
  '      return chatClient.prompt().user(prompt).call().content();',
  '    } catch (Exception ex) {',
  '      throw AppException.aiServiceError(ex.getMessage());',
  '    }',
  '  }',
  '  public String oneLine() { return "short"; }',
  '}',
].join('\n');
const methods = Parser.extract(source, javaFile, {});
const byName = (name) => methods.filter((fn) => fn.name === name);
assert.equal(byName('chat').length, 1, 'only one chat declaration');
assert.equal(byName('callAiForText').length, 1, 'only one callAiForText declaration');
assert.equal(byName('oneLine').length, 1, 'single-line method remains intact');
assert.equal(byName('chat')[0].line, 3);
assert.equal(byName('chat')[0].endLine, 13);
assert.equal(byName('callAiForText')[0].line, 14);
assert.equal(byName('callAiForText')[0].endLine, 20);
assert.equal(byName('oneLine')[0].endLine, 21);
assert.equal(byName('chat')[0].className, 'ChatService');
assert.equal(byName('chat')[0].isClassMethod, true);
assert.ok(byName('chat')[0].endLine > byName('chat')[0].line, 'a real method body must not be truncated');
assert.match(byName('chat')[0].code, /return process\(message\);/);
assert.match(byName('callAiForText')[0].code, /chatClient\.prompt\(\)/);
assert.ok(!methods.some((fn) => ['O', 'fake', 'process', 'fallback'].includes(fn.name)), 'invocations / text are not declarations');

// Export must preserve functions (bounded evidence) and file identity while
// excluding full source from every file snapshot. No UI-framework dependency.
const rawSentinel = 'PRIVATE_FULL_SOURCE_SENTINEL_DO_NOT_EXPORT';
const workingResult = {
  engineVersion: ENGINE_VERSION,
  files: [{path:javaFile, name:'ChatService.java', language:'java', content:rawSentinel}],
  fileContents: {[javaFile]:rawSentinel},
  functions: [{name:'chat',file:javaFile,line:3,endLine:13,code:'  public String chat(...) {\n  // ...'}],
  extractionSnapshot: {entries:[{path:javaFile,functions:[{name:'chat',code:'bounded evidence'}]}]},
};
const serialized=toDownloadableAnalysisJson(workingResult,{name:'synthetic-app'},'2026-10-28T00:00:00.000Z');
const exported=JSON.parse(serialized);
assert.equal(exported.exportFormat,'ai-legacy-bridge-analysis-json');
assert.equal(exported.sourceCodeIncluded,false);
assert.equal(exported.analysis.engineVersion,ENGINE_VERSION);
assert.equal(exported.repository.name,'synthetic-app');
assert.equal(exported.analysis.files[0].path,javaFile);
assert.ok(!('content' in exported.analysis.files[0]));
assert.ok(!('fileContents' in exported.analysis));
assert.ok(!serialized.includes(rawSentinel));
assert.match(serialized,/bounded evidence/);
assert.ok(!JSON.parse(toAnalysisJson(workingResult)).files[0].content);
console.log(JSON.stringify({status:'passed',engineVersion:ENGINE_VERSION,checks:20,javaChatRange:[3,13],javaAiRange:[14,20],rawSourceInDownload:false}));
