/** Existing scanner correctness tests. No new analysis sections or export keys. */
import assert from 'node:assert/strict';
import { Parser } from '../parser.js';
import { discoverEndpoints, extractClientApiCalls, analyzeApiContracts } from '../api.js';
import { extractDatabaseSchema } from '../db.js';
import { analyzeSemanticIntelligence } from '../semanticIntelligence.js';
import { analyzeRepository } from '../orchestrator.js';

const file = (path, content) => ({ path, name: path.split('/').at(-1), content, isCode: true });
const security = (path, code) => Parser.detectSecurity([file(path, code)]);
let checks = 0;
const check = (condition, description) => { assert.ok(condition, description); checks++; };

// No false command-execution report for ordinary methods named exec.
check(!security('src/scanner.js', 'const m = /value/.exec(input);').some(f => f.title === 'Command Execution'), 'RegExp.exec is not command execution');
check(!security('src/tool.js', 'const result = matcher.exec(input);').some(f => f.title === 'Command Execution'), 'receiver.exec is not command execution');
check(security('src/server.js', "const { exec } = require('node:child_process'); exec(command);").some(f => f.title === 'Command Execution'), 'bare exec must still be detected');
check(security('src/server.js', 'child_process.exec(command);').some(f => f.title === 'Command Execution'), 'child_process.exec must still be detected');
check(!security('src/docs.js', 'const docs = "eval(userInput)";').some(f => f.title === 'Dynamic Code Execution'), 'docs are not runnable eval');
check(security('src/run.js', 'eval(userInput);').some(f => f.title === 'Dynamic Code Execution'), 'JS eval detection retained');
check(!security('src/model.py', 'model.eval()').some(f => /Python eval/.test(f.title)), 'model.eval not arbitrary Python eval');
check(security('src/run.py', 'result = eval(user_data)').some(f => f.title === 'Python eval()'), 'real Python eval retained');
check(!security('backend/models.py', "obj = __import__('math')").some(f => f.title === 'Dynamic Import'), 'fixed Python module not dynamic');
check(security('backend/models.py', 'obj = __import__(name_from_request)').some(f => f.title === 'Dynamic Import'), 'computed Python import retained');

// Existing security-rule precision: validation messages and computed credentials
// are not source-embedded passwords, while real secret literals still warn.
check(!security('frontend/src/pages/auth/RegisterPage.tsx', "if (!form.password || form.password.length < 8) e.password = 'Password must be at least 8 characters';").some(f=>f.title==='Hardcoded Secret'), 'password validation message not a literal credential');
check(!security('frontend/src/pages/auth/LoginPage.tsx', "if (!form.password) e.password = 'Password is required';").some(f=>f.title==='Hardcoded Secret'), 'required-password validation is not a secret');
check(!security('frontend/src/pages/settings/SettingsPage.tsx', "if (!passwords.currentPassword) errs.currentPassword = 'Required';").some(f=>f.title==='Hardcoded Secret'), 'settings validation error bags not credentials');
check(!security('frontend/src/pages/settings/SettingsPage.tsx', "errs.newPassword = 'Must be at least 8 characters';").some(f=>f.title==='Hardcoded Secret'), 'message on a password field not a credential');
check(!security('frontend/src/pages/settings/SettingsPage.tsx', "if (passwords.newPassword.length < 8) errs.newPassword = 'Min 8 characters';").some(f=>f.title==='Hardcoded Secret'), 'minimum-length validation message not a credential');
check(security('src/credentials.js', "const password = 'real-looking-secret-value';").some(f=>f.title==='Hardcoded Secret'), 'literal credentials still detected');
check(security('src/errors.js', "errors.password = 'genuinely-secret-value';").some(f=>f.title==='Hardcoded Secret'), 'real secrets not suppressed just because receiver is errors');
check(security('src/credentials.js', "const password = 'real-' + 'looking-secret';").some(f=>f.title==='Hardcoded Secret'), 'static concatenated credential still detected');
check(!security('services/api/app/routes.py', "role(ctx,'admin');secret='ast_'+secrets.token_urlsafe(40)").some(f=>f.title==='Hardcoded Secret'), 'computed secure random token not a static secret');
check(!security('services/api/app/routes.py', "token = 'prefix_' + generate_secure_token()").some(f=>f.title==='Hardcoded Secret'), 'computed token expression not static');
check(!security('src/dataFlow.js', "const SINKS=[{kind:'xss', re: /\\binnerHTML\\s*=|\\bdangerouslySetInnerHTML\\b/i}];").some(f=>/XSS/.test(f.title)), 'regex sink definitions are not executable HTML sinks');
check(!security('src/MigratePage.jsx', "return <p>This page documents <code>eval()</code>, but never invokes it.</p>;").some(f=>f.title==='Dynamic Code Execution'), 'literal JSX documentation not executed');
check(security('src/Unsafe.jsx', "return <p>{eval(userInput)}</p>;").some(f=>f.title==='Dynamic Code Execution'), 'actual JSX expression still detected');
check(security('src/Unsafe.jsx', "return <span dangerouslySetInnerHTML={{__html: html}} />;").some(f=>f.title==='Potential XSS Sink'), 'real HTML sinks still detected');

const routes = [file('backend/Controller.java', `@RestController\n@RequestMapping("/api/repository")\nclass Controller {\n  @GetMapping("/list") Object list() {}\n  @DeleteMapping("/{id}") void delete() {}\n  @PostMapping("/ingest") void ingest() {}\n}`)];
const client = file('frontend/client.js', `const BASE_URL = 'http://localhost:8080';
fetch(\`\${BASE_URL}/api/repository/list\`);
fetch(\`\${BASE_URL}/api/repository/\${repositoryId}\`, { method: 'DELETE' });
fetch(\`\${BASE_URL}/api/repository/ingest\`, { method: 'POST' });
fetch('/api/first');
fetch('/api/second', { method: 'POST' });
fetch(\`\${BASE_URL}/ordinary/page\`);`);
const calls = extractClientApiCalls([client]);
check(calls.length === 5, 'must detect five API calls and ignore ordinary navigation');
check(calls.find(c=>c.path==='/api/repository/list')?.method==='GET', 'GET not borrowed from later POST');
check(calls.find(c=>c.path==='/api/repository/:param')?.method==='DELETE', 'method preserved with templated id');
check(calls.find(c=>c.path==='/api/repository/ingest')?.method==='POST', 'POST preserved');
check(calls.find(c=>c.path==='/api/first')?.method==='GET', 'GET not borrowed from next call');
const contract=analyzeApiContracts([client,...routes],discoverEndpoints(routes));
check(contract.matchedCalls === 3, 'three frontend/backend contracts match');

const dbFiles = [
 file('src/schema.sql', `CREATE TABLE users (id integer PRIMARY KEY, tenant_id integer REFERENCES tenants(id));\nCREATE TABLE tenants (id integer PRIMARY KEY);`),
 file('src/migration.sql', `CREATE TABLE users (id integer PRIMARY KEY, email varchar(255));`),
 file('src/User.java', '@Entity\n@Table(name = "users")\nclass User {\n @Column\n private String name;\n}'),
 file('src/models.py', `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
class Base(DeclarativeBase):
    pass
class User(Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey('tenants.id'))
class Event(Base):
    __tablename__ = 'events'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
class Helper:
    __tablename__ = 'not_a_sqlalchemy_table'`),
];
const db=extractDatabaseSchema(dbFiles);
check(db.tables.length === 3, 'SQL/JPA/ORM duplicates are a single physical table');
check(db.tables.filter(t=>t.name==='users').length === 1, 'unique users table');
check(db.tables.find(t=>t.name==='users').columns.some(c=>c.name==='email'), 'additional migration columns preserved');
check(db.tables.find(t=>t.name==='events').foreignKeys.some(fk=>fk.referencesTable==='users'), 'SQLAlchemy foreign key retained');
check(!db.tables.some(t=>t.name==='not_a_sqlalchemy_table'), 'non-model class is not table');
check((db.mermaidErDiagram.match(/users \{/g)||[]).length === 1, 'ER diagram does not repeat duplicated table');

const lombok = Parser.extract(`@Data
class User {
  @JoinTable(name = "user_role",
      joinColumns = @JoinColumn(name = "user_id"),
      inverseJoinColumns = @JoinColumn(name = "role_id"))
  private String title;
}`, 'backend/User.java', {});
check(lombok.some(fn => fn.name === 'getTitle' && fn.isSynthetic), 'real Lombok getter preserved');
check(!lombok.some(fn => /joinColumns/i.test(fn.name)), 'annotation parameters do not create Lombok accessors');

const semantics=analyzeSemanticIntelligence({files:[file('src/data.py', 'class PrimaryFile:\n    path: str\nclass Derived(PrimaryFile):\n    pass')],classes:[{file:'src/data.py',name:'PrimaryFile',line:1},{file:'src/data.py',name:'Derived',line:3}]});
check(!semantics.inheritance.some(i=>i.baseName==='path'), 'Python dataclass field is not inheritance');
check(semantics.inheritance.some(i=>i.childName==='Derived'&&i.baseName==='PrimaryFile'), 'Python real inheritance retained');

const result=await analyzeRepository({name:'scanner-correctness',source:'test'},[
 ...routes,client,...dbFiles,
]);
check(result.outputContractValidation?.status==='valid', 'integrated analysis contract stays valid');
check(result.apiContractAnalysis?.clientCalls === 3 && result.apiContractAnalysis?.matchedCalls === 3, 'integrated contract counts only source-backed routes, not unmatched /api navigation');
check(result.databaseSchema?.tables?.length===3, 'integrated schema deduplication');
console.log(JSON.stringify({status:'passed',checks,apiCalls:calls.length,matchedCalls:contract.matchedCalls,uniqueTables:db.tables.length,exportValid:true}));
