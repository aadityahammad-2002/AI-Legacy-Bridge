"""Batch 4 isolated offline acceptance. Zero network, DB or paid LLM calls.

This suite exercises real security, retrieval, tool, FastAPI and lifecycle
functions using fake adapters for external services. Run from ai-service:
    python tests/run_batch4_offline.py
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
import importlib.util
import sys
import types
from uuid import UUID

APP = Path(__file__).resolve().parents[1] / 'app'
package = ModuleType('app')
package.__path__ = [str(APP)]
sys.modules['app'] = package


def stub(name, **data):
    module = types.ModuleType('app.' + name)
    vars(module).update(data)
    sys.modules['app.' + name] = module
    setattr(package, name, module)
    return module


def load(name):
    spec = importlib.util.spec_from_file_location('app.'+name, APP/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules['app.'+name] = module
    setattr(package, name, module)
    spec.loader.exec_module(module)
    return module

checks = 0

def check(value, description):
    global checks
    assert value, description
    checks += 1
    print(f'PASS {checks:02d}: {description}')

safety = load('source_safety')
check(safety.redact_text('OPENAI_API_KEY=sk-example123456789012345') == 'OPENAI_API_KEY='+safety.REDACTED,
      'environment API key masked')
check('hunter2' not in safety.redact_text('password: hunter2'), 'YAML password masked')
check('SECRET123' not in safety.redact_text('"apiKey": "SECRET123"'), 'JSON API key masked')
check('ABCDEFGHIJKL' not in safety.redact_text('Authorization: Bearer ABCDEFGHIJKL'),
      'bearer credential masked')
check('PRIVATE KEY' not in safety.redact_text('-----BEGIN PRIVATE KEY-----\nrawsecret\n-----END PRIVATE KEY-----'),
      'PEM private key masked')
check('os.getenv' in safety.redact_text("api_key = os.getenv('API_KEY')"),
      'environment lookups remain explainable')
check(safety.is_sensitive_path('backend/.env'), 'sensitive .env excluded')
check(safety.is_sensitive_path('secrets/private.pem'), 'sensitive certificate excluded')
check(not safety.is_sensitive_path('backend/.env.example'), 'safe config example allowed')
check(safety.is_valid_repo_path('backend/app/main.py'), 'normal relative path allowed')
check(not safety.is_valid_repo_path('../secrets'), 'parent traversal blocked')
check(not safety.is_valid_repo_path('C:\\Windows\\private'), 'Windows absolute path blocked')

config = stub('config', CORS_ALLOWED_ORIGINS=['http://localhost:5173'],
              LLM_MODEL='fake-model', LLM_BASE_URL='https://localhost.invalid',
              EMBEDDING_PROVIDER='hashing', NEO4J_PASSWORD='', PORT=8001)
statuses = []
records = {'src/main.py': 'password = "hunter2"\n\ndef run():\n    return 1\n',
           'backend/.env': 'OPENAI_API_KEY=sk-example123456789012345'}
class Cursor:
    def __init__(self):
        self.sql = ''
        self.params = ()
    def execute(self, sql, params=None):
        self.sql = sql
        self.params = params
        statuses.append(('SQL',sql,params))
    def fetchone(self):
        if 'SELECT id FROM repositories' in self.sql:
            return {'id': 'repo'}
        if 'revision' in self.sql:
            return {'revision': 1}
        if 'SELECT content FROM files' in self.sql:
            content = records.get(self.params[-1])
            return {'content': content} if content is not None else None
        return None
    def fetchall(self):
        if 'SELECT path, content FROM files' in self.sql:
            return [{'path': p, 'content': records[p]} for p in self.params[1] if p in records]
        if 'SELECT path FROM files' in self.sql:
            return [{'path': p} for p in records]
        return []
@contextmanager
def get_cursor(*a, **k):
    yield Cursor()

db = stub('db', get_cursor=get_cursor, init_pool=lambda: statuses.append(('POOL','init')),
          close_pool=lambda: statuses.append(('POOL','close')))
stub('graph_rag', retrieve_ranked_chunks=lambda *a:[], get_structural_neighborhood=lambda *a:[])
stub('graph_store', close_driver=lambda: statuses.append(('GRAPH','close')))
stub('embedding', embed=lambda *a: [.0]*384)
stub('rag', find_similar=lambda *a, **k: [
    {'file_path':'src/main.py','content':'api_key = "hunter2"','similarity':.88,'function_name':'run'},
    {'file_path':'backend/.env','content':records['backend/.env'],'similarity':.84,'function_name':None},
], index_repository=lambda *a: 4)
stub('agent_graph', run=lambda *a,**k:{'answer':'code is present','touched_files':['src/main.py','backend/.env']},
     evict_repository=lambda *a:None)
class LlmError(Exception):
    def __init__(self, message, http_status=503):
        super().__init__(message);self.http_status=http_status
stub('llm_client', LlmError=LlmError)
stub('evaluation', evaluate_answer=lambda *a: (_ for _ in ()).throw(ValueError('api_key=SHOULD_NOT_LEAK')))
stub('code_assist', generate_tests=lambda *a: (_ for _ in ()).throw(ValueError('api_key=SHOULD_NOT_LEAK')),
     suggest_migration=lambda *a: (_ for _ in ()).throw(RuntimeError('api_key=SHOULD_NOT_LEAK')))
errors = load('provider_errors')
tools = load('tools')
context = load('context_retrieval')

out = tools._read_file('repo','src/main.py',{})
check('hunter2' not in out.content and safety.REDACTED in out.content,
      'read_file masks literal credentials in tool result')
check(out.touched_files == ['src/main.py'], 'safe file is still citable')
checks_before = len(statuses)
blocked = tools._read_file('repo','backend/.env',{})
check('cannot' in blocked.content and not blocked.touched_files,
      'sensitive file cannot be sent to model')
check(len(statuses) == checks_before, 'sensitive read rejected before DB fetch')
check(not tools._read_file('repo','../../secret',{}).touched_files, 'invalid paths cannot cite files')
search = tools._search_code('repo','key')
check('hunter2' not in search.content and 'sk-example' not in search.content,
      'semantic tool snippets masked and sensitive paths excluded')
check(search.touched_files == ['src/main.py'], 'search citations contain only safe paths')

ctx = context.RetrievedContext(
    all_file_paths=['src/main.py','backend/.env'],
    primary_file=context.PrimaryFile('src/main.py',records['src/main.py']),
    matched_files=[], focused_node=None, focused_files=[], similar_chunks=[
        {'file_path':'src/main.py','function_name':'run','content':'password: hunter2'},
        {'file_path':'backend/.env','function_name':None,'content':records['backend/.env']},
    ])
prompt = ctx.to_prompt_text()
check('hunter2' not in prompt and 'sk-example' not in prompt, 'RAG prompt redacts all source evidence')
check('backend/.env' not in prompt, 'sensitive file excluded from prompt overview')
matched = context._find_files_mentioned_in_question('repo','Explain src/main.py',None,list(records))
check([row.path for row in matched] == ['src/main.py'], 'mentioned files resolved exactly')
check('path = ANY' in statuses[-1][1], 'mentioned file lookup is a single bounded query')

main = load('main')
from fastapi.testclient import TestClient
repo = '18544b30-b7a7-4122-892d-e68d2349075a'
# The mocked retrieval function mirrors the real response without LLM calls.
main.context_retrieval.retrieve = lambda *a: ctx
with TestClient(main.app) as client:
    health = client.get('/health')
    check(health.status_code == 200 and health.json() == {'status':'ok'}, 'ASGI health route works')
    r = client.post('/api/ai/ask',json={'repositoryId': repo,'question':'Explain file'})
    check(r.status_code == 200 and r.json()['sourceFiles'] == ['src/main.py'],
          'ask returns only known non-sensitive source references')
    bad_path = client.post('/api/ai/ask',json={'repositoryId': repo,'question':'q',
                                               'openFilePath':'../../secrets'})
    check(bad_path.status_code == 422, 'invalid open-file path rejected')
    huge = client.post('/api/ai/ask',json={'repositoryId':repo,'question':'x'*4500})
    check(huge.status_code == 422, 'ask request length capped')
    large_header = client.post('/api/ai/ask',content=b'{}',headers={'content-length':str(2*1024*1024)})
    check(large_header.status_code == 413, 'oversized request Content-Length rejected')
    index = client.post(f'/index/{repo}')
    check(index.status_code == 200 and index.json()['chunksIndexed'] == 4,
          'index endpoint preserves Java worker success contract')
    eval_resp = client.post('/evaluate',json={'question':'q','contextText':'c','answer':'a'})
    check(eval_resp.status_code == 500 and 'SHOULD_NOT_LEAK' not in eval_resp.text,
          'evaluation exception body sanitized')
    tests_resp = client.post('/api/code/generate-tests',json={'functionName':'run'})
    check(tests_resp.status_code == 502 and 'SHOULD_NOT_LEAK' not in tests_resp.text,
          'code-assist parsing errors sanitized')
    migrate = client.post('/api/code/suggest-migration',json={'filePath':'x.py'})
    check(migrate.status_code == 500 and 'SHOULD_NOT_LEAK' not in migrate.text,
          'migration exceptions sanitized')
    invalid_code = client.post('/api/code/generate-tests',json={'functionName':'run','code':'x'*81000})
    check(invalid_code.status_code == 422, 'code-assist oversized field rejected')
check(('POOL','init') in statuses and ('GRAPH','close') in statuses and ('POOL','close') in statuses,
      'ASGI startup and shutdown close pooled resources')
print(f'\nBatch 4 offline acceptance: {checks}/{checks} PASSED (no provider or database calls).')
