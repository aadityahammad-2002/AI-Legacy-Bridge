"""Dependency-light Batch 3 smoke suite; does not import LangChain or call APIs.

Run: python tests/run_batch3_offline.py
Tests real Python module functions and isolated AST functions with fake
LangChain message classes where runtime dependencies are unavailable.
Full dependency-based verification: python -m pytest -q.
"""
from pathlib import Path
from contextlib import contextmanager
import ast
import importlib.util
import sys
import threading
import types

APP = Path(__file__).resolve().parents[1] / 'app'
assert APP.is_dir()
pkg = types.ModuleType('app'); pkg.__path__ = [str(APP)]
sys.modules['app'] = pkg

def stub(name, **items):
    obj = types.ModuleType('app.'+name)
    obj.__dict__.update(items)
    sys.modules['app.'+name]=obj
    setattr(pkg,name,obj)
    return obj

def load(name):
    spec=importlib.util.spec_from_file_location('app.'+name,APP/(name+'.py'))
    mod=importlib.util.module_from_spec(spec)
    sys.modules['app.'+name]=mod
    setattr(pkg,name,mod)
    spec.loader.exec_module(mod)
    return mod

config=stub('config',GRAPH_HOP_LIMIT=2,NEO4J_PASSWORD='',TPM_LIMIT=5500,TPM_SAFETY_BUFFER=0)
stub('db',get_cursor=None)
stub('rag',find_similar=None)
stub('graph_store',batch_shortest_path_distances=None,get_neighborhood=None)
stub('embedding',embed=None)
base_tools=load('tools')
dependency=load('dependency_graph')
rank=load('graph_rag')
budget=load('token_budget')
errors=load('provider_errors')
checks=0

def check(ok,description):
    global checks
    assert ok,description
    checks+=1
    print(f'PASS {checks:02d}: {description}')

graph=dependency.adjacency_for_edges([
    {'source':'root.py','target':'a.py'},
    {'source':'a.py','target':'b.py'},
    {'source':'b.py','target':'root.py'},
    {'source':'b.py','target':'c.py'},
])
check(dependency.walk(graph,'root.py',1)=={'root.py':0,'a.py':1,'b.py':1},'cycle-safe bounded BFS')
check(dependency.walk(graph,'root.py',2)['c.py']==2,'shortest-hop distance')
check(dependency.bounded_hops(999)==6,'graph depth safety cap')

class Cursor:
    def execute(self,sql,params):
        self.sql=sql;self.params=params
        statements.append((sql,params))
    def fetchall(self):
        return [{'source':'root.py','target':'a.py'}, {'source':'a.py','target':'b.py'}]
@contextmanager
def fake_db():
    yield Cursor()
statements=[]
pkg.db.get_cursor=fake_db
check(dependency.distance_map('repo','root.py',['b.py','missing.py'])=={'b.py':2},
      'Postgres dependency distance retrieval')
check('JOIN files src' in statements[-1][0] and 'JOIN files dst' in statements[-1][0],
      'external dependencies not treated as file edges')
check(statements[-1][1][0]=='repo','Postgres graph repository scoped')
check(dependency.neighborhood('repo','root.py')==['a.py','b.py'],
      'Postgres structural neighborhood without Neo4j')

pkg.rag.find_similar=lambda repo, vec, count: [
    {'file_path':'unrelated.py','content':'u','similarity':0.80},
    {'file_path':'a.py','content':'a','similarity':0.74}]
old_distance=dependency.distance_map
calls=[]
dependency.distance_map=lambda repo,anchor,targets: calls.append(tuple(targets)) or {'a.py':1}
ranked=rank.retrieve_ranked_chunks('repo',[0.1],'root.py',2)
check([c.file_path for c in ranked]==['a.py','unrelated.py'],
      'graph reranks semantically weaker but structurally close evidence')
check(len(calls)==1,'graph distance is batched, not N+1')
check(ranked[0].graph_distance==1,'graph distance captured with evidence')
dependency.distance_map=old_distance

config.NEO4J_PASSWORD='configured'
pkg.graph_store.batch_shortest_path_distances=lambda *a: (_ for _ in ()).throw(ConnectionError('unavailable'))
dependency.distance_map=lambda r,a,p:{'a.py':2}
check(rank._distances('repo','root.py',[{'file_path':'a.py'}])=={'a.py':2},
      'Neo4j outage falls back to PostgreSQL')
config.NEO4J_PASSWORD=''
dependency.neighborhood=lambda *a:['near.py']
check(rank.get_structural_neighborhood('repo','anchor.py')==['near.py'],
      'Neo4j disabled still supplies structural neighbor')

# Real read_file implementation using fake DB rows.
class FileCursor:
    def execute(self,sql,params):
        check('repository_id = %s AND path = %s' in sql, 'file SQL repository scoped')
    def fetchone(self):
        return {'content':'first\nsecond\nthird\nfourth\n'}
@contextmanager
def file_cursor():yield FileCursor()
pkg.db.get_cursor=file_cursor
out=base_tools._read_file('r','path.py',{},2,2)
check('second\nthird' in out.content and 'first' not in out.content,
      'read_file supports bounded source windows')
check(out.touched_files==['path.py'],'read_file reports actually read file')
check('Partial file' in out.content,'large file pagination evidence')
check(base_tools._read_file('r','p',{},0,3).touched_files==[],
      'invalid source window cannot cite file')

# Native module with no LangChain dependencies.
class Error(Exception):status_code=402
failure=errors.classify(Error('API-KEY-VERY-SECRET'))
check(failure.http_status==402 and 'SECRET' not in str(failure),
      'paid API error sanitized')
class RateError(Exception):status_code=429
check(errors.classify(RateError()).http_status==429,'quota maps to actionable HTTP 429')
check(errors.classify(ValueError('local bug')) is None,'local code defects not disguised as provider errors')

budget._usage_log.clear()
barrier=threading.Barrier(4)
reserved=[]
def race():
    barrier.wait()
    ticket,_=budget.reserve(2500)
    reserved.append(ticket)
threads=[threading.Thread(target=race) for _ in range(4)]
for thread in threads:thread.start()
for thread in threads:thread.join()
check(sum(ticket is not None for ticket in reserved)==2,'parallel reservations cannot exceed TPM')
for ticket in reserved:budget.cancel(ticket)
check(budget.seconds_until_budget_available(5000)==0.0,
      'cancelled requests release estimated budget')

# Pull and execute isolated, real agent helper functions with fake messages.
class HumanMessage:
    def __init__(self,content='',id=None):self.content=content;self.id=id
class AIMessage:
    def __init__(self,content='',tool_calls=None,id=None):
        self.content=content;self.tool_calls=tool_calls or [];self.id=id
class ToolMessage:
    def __init__(self,content='',tool_call_id='',artifact=None,id=None):
        self.content=content;self.tool_call_id=tool_call_id;self.artifact=artifact;self.id=id
class RemoveMessage:
    def __init__(self,id):self.id=id

agent_source=ast.parse((APP/'agent_graph.py').read_text())
names={'_build_touched_files_node','_tool_limit_node','_agent_edge',
       '_trim_complete_turns','_messages_to_prune'}
functions=[]
for node in agent_source.body:
    if isinstance(node,ast.FunctionDef) and node.name in names:
        node.decorator_list=[]
        node.returns=None
        for arg in node.args.args:
            arg.annotation=None
        functions.append(node)
context={'HumanMessage':HumanMessage,'AIMessage':AIMessage,
         'ToolMessage':ToolMessage,'RemoveMessage':RemoveMessage,
         'AgentState':dict,'MAX_TOOL_ROUNDS':4}
exec(compile(ast.fix_missing_locations(ast.Module(body=functions,type_ignores=[])),
             '<agent-helpers>', 'exec'),context)
last=AIMessage(tool_calls=[{'id':'recent','name':'read_file','args':{'path':'fresh.py'}}])
seen=[HumanMessage('old'),AIMessage(tool_calls=[{'id':'old'}]),
      ToolMessage('old code','old',{'touched_files':['old.py']}),
      HumanMessage('new'),last,ToolMessage('new code','recent',{'touched_files':['fresh.py']})]
result=context['_build_touched_files_node']('repo',{})(
    {'messages':seen,'touched_files':[],'tool_rounds':0})
check(result['touched_files']==['fresh.py'], 'track actual latest tool artifact without rerun')
check(result['tool_rounds']==1,'tool round increments only after tools execute')
check(context['_agent_edge']({'messages':[last],'tool_rounds':4})=='limit',
      'agent tool limit enforced without extra paid call')
closed=context['_tool_limit_node']({'messages':[last]})['messages']
check(isinstance(closed[0],ToolMessage) and closed[0].tool_call_id=='recent',
      'tool limit closes outstanding tool ids')
old=[HumanMessage('first','m1'),AIMessage('answer','',id='m2')]
new=[HumanMessage('second','m3'),AIMessage('answer','',id='m4')]
check({m.id for m in context['_messages_to_prune'](old+new,new)}=={'m1','m2'},
      'checkpoint prunes only older turn ids')

print(f'\nBatch 3 dependency-free smoke checks: {checks}/{checks} PASSED (no external calls).')
