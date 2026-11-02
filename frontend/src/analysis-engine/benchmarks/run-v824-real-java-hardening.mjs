/** Real Spring/Java failure-pattern regressions, deliberately small and labeled.
 * This is structural correctness testing, NOT compiler or runtime verification. */
import assert from 'node:assert/strict';
import { analyzeRepository } from '../orchestrator.js';
import { Parser } from '../parser.js';
import { discoverEndpoints } from '../api.js';
import { analyzeFrameworkSignals } from '../frameworkAnalysis.js';
import { analyzeBusinessIntelligence } from '../businessIntelligence.js';
import { classifyAnalysisSource } from '../sourceClassification.js';
import { toAnalysisJson } from '../reportFormats.js';
import { ENGINE_VERSION } from '../engineVersion.js';

const controller = {
  path: 'backend/src/main/java/com/example/hrms/controller/EmployeeController.java',
  content: [
    'package com.example.hrms.controller;',
    '@RestController',
    '@RequestMapping("/api/employees")',
    'public class EmployeeController {',
    '  @GetMapping',
    '  public ResponseEntity<ApiResponse<Employee>> list() { return null; }',
    '  @PostMapping()',
    '  public ResponseEntity<Employee> create() { return null; }',
    '  @GetMapping("/{id}")',
    '  public ResponseEntity<Employee> find(Long id) { return null; }',
    '}',
  ].join('\n'),
};
const service = {
  path: 'backend/src/main/java/com/example/hrms/service/EmployeeService.java',
  content: [
    'public class EmployeeService {',
    '  public void register(UserRepository userRepository, RegisterRequest request) {',
    '    if (userRepository.existsByEmail(request.getEmail())) {',
    '      throw new UserAlreadyExistsException("Email already registered");',
    '    }',
    '    String prompt = """',
    '      Sample complexity: O(n), O(n²), O(?)',
    '      """;',
    '    return;',
    '  }',
    '  private String callAiForJson(String prompt) { return prompt; }',
    '  public void seed() {',
    '    new RoleSeed("admin");',
    '    return;',
    '  }',
    '}',
  ].join('\n'),
};
const examples = {path:'src/benchmarks/Sample.java',content:'@GetMapping("/fake")\nclass Foo {}'};
const multilineSpring = discoverEndpoints([{path:controller.path,content:'@RestController\n@RequestMapping("/api")\nclass C {\n@GetMapping\n("/wrapped")\npublic String wrapped() { return "ok"; }\n}'}]);
assert.equal(multilineSpring.length, 1, 'line-wrapped mapping must not be duplicated as a no-argument route');
assert.equal(multilineSpring[0].path,'/api/wrapped');
assert.equal(classifyAnalysisSource(controller.path),'application');
assert.equal(classifyAnalysisSource('docs/examples/demo.java'),'example');
assert.equal(classifyAnalysisSource('src/benchmarks/Sample.java'),'test-or-fixture');
const endpoint = discoverEndpoints([controller, service, examples]);
assert.equal(endpoint.length,3,'all three genuine endpoints, no fixtures');
assert.deepEqual(endpoint.map(x=>`${x.method} ${x.path}`).sort(),[
  'GET /api/employees','GET /api/employees/{id}','POST /api/employees',
]);
const functions = Parser.extract(service.content, service.path, {});
assert.ok(functions.some(x=>x.name==='register'));
assert.ok(functions.some(x=>x.name==='callAiForJson'));
assert.ok(!functions.some(x=>['O','RoleSeed','UserAlreadyExistsException'].includes(x.name)),'no fake method declarations');
const rules = analyzeBusinessIntelligence([service],{functions});
assert.ok(rules.rules.some(x=>x.line===3 && x.relevance.category==='business-likely'), 'duplicate-email business rule is preserved');
const frameworks = analyzeFrameworkSignals([controller,service,examples], {functions: Parser.extract(controller.content,controller.path,{})});
assert.equal(frameworks.routes.length,3,'framework graph also contains genuine route inventory');
const full = await analyzeRepository({name:'spring-java-regression',source:'local'},[controller,service,examples]);
assert.equal(full.apiEndpoints.length,3);
assert.equal(full.executionIntelligence.summary.tracedEndpoints,3);
assert.equal(full.graphQuality.summary.invalidLine,0);
assert.equal(full.graphQuality.summary.danglingEdges,0);
assert.ok(full.businessIntelligence.rules.some(x=>x.file===service.path && /existsByEmail/.test(x.condition)));
const exportResult=JSON.parse(toAnalysisJson({...full,fileContents:{[controller.path]:controller.content}}));
assert.ok(!('fileContents' in exportResult));
assert.ok(exportResult.files.every(x=>!('content' in x)),'file snapshots must not export complete source');
assert.ok(exportResult.functions.some(x=>x.code),'function-level source evidence retained');
assert.equal(exportResult.engineVersion,ENGINE_VERSION);
const oldShape={exportFormat:'ai-legacy-bridge-analysis-json',sourceCodeIncluded:false,analysis:exportResult};
assert.ok(!oldShape.analysis.files.some(x=>x.content));
console.log(JSON.stringify({status:'passed',engineVersion:ENGINE_VERSION,checks:17,springRoutes:endpoint.length,traced:full.executionIntelligence.summary.tracedEndpoints,ruleCandidates:rules.rules.length,falseMethodDeclarations:0,rawSourceInExport:false,graphInvalidLines:0}));
