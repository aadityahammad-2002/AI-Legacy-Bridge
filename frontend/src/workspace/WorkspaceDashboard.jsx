import { useMemo, useState, useEffect } from 'react';
import {
    Activity, AlertTriangle, ArrowRight, Boxes, BrainCircuit, Code2, Database, Download,
    FileCode2, FlaskConical, GitBranch, GitCompare, LayoutDashboard, LogOut, Menu,
    MessageSquare, Network, PanelLeftClose, Search, Settings, ShieldAlert, Workflow, X, Eye
} from 'lucide-react';
import SourceDiagram from './InteractiveDiagram.jsx';
import { SourceProvider, SourceLocation, EyeSource } from './SourceViewer.jsx';
import RepositoryExplorer from './RepositoryExplorer.jsx';
import { SecurityVisuals, QualityVisuals } from './IntelligenceVisuals.jsx';
import { TestingStudio, ModernizationStudio } from './WorkflowStudios.jsx';
import TestsPage from '../pages/TestsPage.jsx';
import MigratePage from '../pages/MigratePage.jsx';
import VisualizationExplorerV2 from '../pages/VisualizationExplorerV2.jsx';
import AiExplorerV2 from '../pages/AiExplorerV2.jsx';
import ExplorerV2Boundary from './ExplorerV2Boundary.jsx';
import ExportWorker from '../workers/export.worker.js?worker';
import { toWorkspaceAnalysisSourceJson } from '../export/workspaceAnalysisSourceExport.js';
import { runWorker } from '../workers/workerClient.js';
import { asArray, safePath, sensitivePath, isConfirmed, makeArchitecture, makeLayerGraph, makeMessageGraph, makeDatabase, makeCallGraph, makeApiGraph, riskLevel, findingLocation, moduleSummary, makeTierArchitecture, makeServiceCandidates } from './workspaceData.js';
import { sourcePathSet, normalizeWorkspaceContext, rememberWorkspaceFocus, recallWorkspaceFocus, forgetWorkspaceFocus } from './workspaceContext.js';
import './WorkspaceDashboard.css';

const NAV = [
    { group:'WORKSPACE',pages:[['dashboard','Overview',LayoutDashboard]] },
    { group:'EXPLORE',pages:[['visualization-preview','Visualization Explorer',Network],['architecture','Architecture Explorer',Boxes],['database','Database Schema',Database],['api','API Explorer',Workflow],['call-graph','Call Graph',GitBranch]] },
    { group:'INTELLIGENCE',pages:[['ai-preview','AI Explorer',MessageSquare],['security','Security Center',ShieldAlert],['quality','Code Quality',Activity],['ml-insights','ML Insights',BrainCircuit]] },
    { group:'TOOLS',pages:[['tests','Testing Studio',FlaskConical],['migrate','Modernization Studio',GitCompare]] },
];
const NAV_MAP=new Map(NAV.flatMap(g=>g.pages.map(([id,name])=>[id,name])));
const format=v=>v==null||v===''?'—':typeof v==='number'?(Number.isFinite(v)?v.toLocaleString():'—'):String(v);
const Empty=({children})=><div className="ws-empty">{children}</div>;
const Block=({title,action,children,className=''})=><section className={`ws-panel ${className}`}><div className="ws-panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
const Stat=({name,value,detail})=><div className="ws-stat"><span>{name}</span><strong>{format(value)}</strong>{detail&&<small>{detail}</small>}</div>;
const Metrics=({items})=><div className="ws-stats">{items.map(item=><Stat key={item[0]} name={item[0]} value={item[1]} detail={item[2]}/>)}</div>;
const Tabs=({options,value,onChange})=><div role="tablist" className="ws-tabs">{options.map(x=><button role="tab" aria-selected={value===x} key={x} onClick={()=>onChange(x)} className={`ws-tab ${value===x?'is-on':''}`}>{x}</button>)}</div>;
const Evidence=SourceLocation;
const isSafeSource=v=>safePath(v)&&!sensitivePath(v);
function Header({title,description,right,children}){return <><div className="ws-breadcrumb">Workspace / <span>{title}</span></div><div className="ws-section-head"><div><h1>{title}</h1><p>{description}</p></div>{right}</div>{children}</>}
function Coverage({result}){const status=result?.analysisCoverage?.status;return <span className={`ws-pill ${status==='complete'?'good':status==='partial'?'warn':''}`} title="Status reported by the Analysis Engine">Analysis {status||'unknown'}</span>}
function Jump({label,to,onNavigate}){return <button className="ws-btn" onClick={()=>onNavigate(to)}>{label} <ArrowRight size={13}/></button>}
function Overview({result,repoMeta,onNavigate,onExport,exporting,onContextSelect,focusFile}) {
    const s=moduleSummary(result),arch=makeArchitecture(result);
    const topFindings=asArray(result?.findings).slice(0,5);
    return <><Header title="Your codebase, decoded." description={`Explore actual analysis for ${repoMeta?.name||result?.repository?.name||'the selected repository'}.`} right={<button className="ws-btn" onClick={onExport} disabled={exporting}><Download size={15}/>{exporting?'Preparing export…':'Export analysis + source'}</button>}/>
        <div className="ws-info"><Coverage result={result}/> <span>All displayed values come from this saved analysis snapshot. Missing information is shown as unavailable, not zero.</span></div>
        <Metrics items={[["Source files",s.files],["Functions",s.functions],["API endpoints",s.endpoints],["Database tables",s.tables],["Security findings",s.security],["Health score",s.health,s.health==null?'Not measured':'Heuristic, not a probability']]}/>
        <div className="ws-two"><Block title="Repository architecture" action={<Jump label="Explore" to="architecture" onNavigate={onNavigate}/>}><SourceDiagram nodes={arch.nodes.slice(0,14)} edges={arch.edges} title="Actual source-module dependencies" onSelect={()=>onNavigate('architecture')}/><p className="ws-small">Module names are grouped from repository paths; edges require resolved source dependencies.</p></Block><Block title="Languages & coverage"><div className="ws-bars">{s.languages.length?s.languages.slice(0,9).map(([language,count])=><div className="ws-bar-row" key={language}><span>{language}</span><div className="ws-track"><div style={{width:`${Math.min(100,count/Math.max(1,s.files||1)*100)}%`}}/></div><b>{count}</b></div>):<Empty>No language metrics were extracted.</Empty>}</div><p className="ws-small">Files analyzed: {format(s.files)} · Resolved dependencies: {format(s.resolvedDependencies)} · Coverage: {s.coverage||'unknown'}.</p></Block></div>
        <Block title="Repository File Explorer" action={<span className="ws-muted">Folder tree · Read-only source · File-level insights</span>}><RepositoryExplorer result={result} onNavigate={onNavigate} onContextSelect={onContextSelect} focusFile={focusFile}/></Block>
        <Block title="Open a workspace"><div className="ws-tiles">{NAV.flatMap(n=>n.pages).filter(([id])=>id!=='dashboard').map(([id,label,Icon])=><button className="ws-tile" key={id} onClick={()=>onNavigate(id)}><Icon size={23}/><strong>{label}</strong><span>{id==='visualization-preview'||id==='ai-preview'?'Interactive V2 workspace · legacy fallback available':'View repository-derived data and evidence'}</span><ArrowRight size={14}/></button>)}</div></Block>
        <Block title="Recent source-backed findings" action={<Jump label="Security Center" to="security" onNavigate={onNavigate}/>}>{topFindings.length?<div className="ws-list">{topFindings.map((f,i)=>{const loc=findingLocation(f);return <div key={`${i}-${f.id||''}`} className="ws-list-item"><strong>{f.title||f.name||f.type||'Finding'}</strong><span className="ws-pill">{riskLevel(f)}</span><Evidence file={loc.path} line={loc.line}/></div>})}</div>:<Empty>{Array.isArray(result?.findings)?'No findings reported in this analysis. This does not prove the repository is free of issues.':'Finding data was not available.'}</Empty>}</Block>
    </>;
}
function Architecture({result,onNavigate,focusFile}){
    const arch=useMemo(()=>makeArchitecture(result),[result]);
    const layers=useMemo(()=>makeLayerGraph(result),[result]);
    const tiers=useMemo(()=>makeTierArchitecture(result),[result]);
    const services=useMemo(()=>makeServiceCandidates(result),[result]);
    const message=useMemo(()=>makeMessageGraph(result),[result]);
    const classes=asArray(result?.classes);
    const [tab,setTab]=useState('Tier architecture'),[selected,setSelected]=useState(null);
    const current=tab==='Tier architecture'?tiers:tab==='Module graph'?arch:tab==='Layer diagram'?layers:tab==='Service architecture'?services:tab==='Service events'?message:{nodes:[],edges:[]};
    const active=current.nodes.find(n=>n.id===selected)
        ||(focusFile?current.nodes.find(n=>n.file===focusFile||n.files?.includes?.(focusFile)):null)
        ||null;
    const related=current.edges.filter(e=>e.source===selected||e.target===selected);
    return <><Header title="Architecture Explorer" description="Explore logical tiers, modules, classes and evidence-backed service boundaries."/>
        <div className="ws-info">A logical tier (2/3/4/5 tiers) and a microservice are different concepts. The number of detected tiers varies by repository; no tiers, services or links are fabricated.</div>
        <Metrics items={[["Grouped modules",arch.nodes.length],["Detected tier categories",tiers.classifiedTierCount],["Service directory candidates",services.nodes.length],["Resolved file dependencies",asArray(result?.dependencies).filter(isConfirmed).length]]}/>
        <Tabs options={['Tier architecture','Module graph','Layer diagram','Service architecture','Classes','Service events','Architecture findings']} value={tab} onChange={v=>{setTab(v);setSelected(null)}}/>
        {['Tier architecture','Module graph','Layer diagram','Service architecture','Service events'].includes(tab)&&<Block title={tab==='Tier architecture'?'Application tier view (source-classified)':tab==='Service architecture'?'Candidate microservice boundaries':tab}>
            {tab==='Service architecture'&&<p className="ws-small">Only groups evidenced by services/* or apps/* are displayed as candidates. Direct dependencies are code references, not verified network traffic. A multi-repository system is outside this single-repository scan.</p>}
            <SourceDiagram nodes={current.nodes} edges={current.edges} selected={selected} onSelect={setSelected} title={tab}/>
            <p className="ws-small">{tab==='Tier architecture'?tiers.semantics:tab==='Service architecture'?services.semantics:tab==='Service events'?'Message-channel matches are low-confidence candidates; not observed broker delivery.':'Edges represent resolved source imports. Layer labels are inferred classifications.'}</p>
        </Block>}
        {tab==='Classes'&&<Block title="Extracted class definitions"><div className="ws-list ws-scroll-list">{classes.map((c,i)=><div className="ws-list-item" key={i}><strong>{c.name||'Unnamed class'}</strong><Evidence file={c.file} line={c.line}/></div>)}{!classes.length&&<Empty>No classes were extracted from supported source files.</Empty>}</div></Block>}
        {tab==='Architecture findings'&&<Block title="Source-backed structural findings"><div className="ws-list">{asArray(result?.issues).length?asArray(result?.issues).map((f,i)=><div className="ws-list-item" key={i}><strong>{f.title||f.name||f.type||'Structural finding'}</strong><span>{f.desc||f.description||'Review source evidence.'}</span>{asArray(f.items).slice(0,4).map((record,j)=><Evidence key={j} file={record.file||record.path} line={record.line}/>)}</div>):<Empty>No architecture findings reported.</Empty>}</div></Block>}
        {active&&<Block title={`Selected: ${active.label}`}><p>{asArray(active.files).length} repository files · {related.length} displayed relationships.</p>
            {active.candidateReason&&<div className="ws-info">{active.candidateReason}</div>}
            {active.layerCounts&&<div className="ws-chips">{Object.entries(active.layerCounts).map(([l,c])=><span key={l} className="ws-pill">{l}: {c}</span>)}</div>}
            <div className="ws-list ws-scroll-list">{asArray(active.files).slice(0,100).map(path=><div className="ws-list-item" key={path}><Evidence file={path}/></div>)}{!asArray(active.files).length&&<Empty>No file-level source location attached to this node.</Empty>}</div>
            {related.map((x,i)=><div className="ws-small" key={i}>{x.source} → {x.target} · {x.count??1} extracted reference(s)</div>)}
            <Jump to="call-graph" label="Explore function calls" onNavigate={onNavigate}/>
        </Block>}
    </>;
}

function DatabaseExplorer({result,onNavigate,onContextSelect,focusFile}){
    const db=useMemo(()=>makeDatabase(result),[result]);
    const [selected,setSelected]=useState(null),[tab,setTab]=useState('ER diagram'),[query,setQuery]=useState('');
    const picked=db.nodes.find(x=>x.id===selected)
        ||(focusFile?db.nodes.find(x=>x.table?.file===focusFile):null)
        ||db.nodes[0]||null;
    const filtered=db.nodes.filter(n=>n.label.toLowerCase().includes(query.toLowerCase()));
    return <><Header title="Database Schema" description="View database tables, extracted columns, foreign keys and ORM sources."/><div className="ws-info">Repository-declared schema only. This is not live database introspection; unknown keys and constraints are never inferred.</div><Metrics items={[["Discovered tables",Array.isArray(result?.databaseSchema?.tables)?db.nodes.length:null],["Resolved foreign-key links",db.edges.length],["Duplicate table names",db.ambiguousNames.length]]}/><Tabs value={tab} onChange={setTab} options={['ER diagram','Table explorer','ORM & sources']}/>
    {tab==='ER diagram'&&<Block title="Entity relationship diagram"><SourceDiagram nodes={db.nodes} edges={db.edges} selected={picked?.id} onSelect={setSelected} title="Foreign-key relationships in repository schema"/><p className="ws-small">Only foreign keys with one unambiguous target table are drawn.</p></Block>}
    <div className="ws-two"><Block title="Discovered tables"><input className="ws-input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search table names…" aria-label="Search tables"/><div className="ws-list ws-scroll-list">{filtered.map(n=><button key={n.id} className={`ws-list-item ${picked?.id===n.id?'selected':''}`} onClick={()=>{setSelected(n.id);if(n.table?.file)onContextSelect?.({file:n.table.file});}}><Database size={15}/><strong>{n.label}</strong><span>{asArray(n.table.columns).length} columns</span></button>)}{!filtered.length&&<Empty>No matching tables in the extracted schema.</Empty>}</div></Block>
    <Block title={picked?`Table: ${picked.label}`:'Table details'}>{picked?<><Evidence file={picked.table.file}/><div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Column</th><th>Type</th><th>Metadata</th></tr></thead><tbody>{asArray(picked.table.columns).map((c,i)=><tr key={i}><td>{c.name||'Unknown'}</td><td>{c.type||'Unknown'}</td><td>{c.primaryKey?'Primary key':c.nullable===false?'Not null':'—'}</td></tr>)}</tbody></table></div><h3>Declared foreign keys</h3><div className="ws-list">{asArray(picked.table.foreignKeys).map((fk,i)=><div key={i} className="ws-list-item">{fk.column||'Column unspecified'} → {fk.referencesTable||'Target unavailable'}</div>)}{!asArray(picked.table.foreignKeys).length&&<Empty>No FK declarations extracted for this table.</Empty>}</div><p className="ws-small">Schema source type: {picked.table.source||'unspecified'}.</p></>:<Empty>No supported table declarations were extracted. Review schema extraction coverage.</Empty>}</Block></div>
    {tab==='ORM & sources'&&<Block title="Schema evidence"><div className="ws-list">{db.nodes.map(n=><div className="ws-list-item" key={n.id}><strong>{n.label}</strong><Evidence file={n.table.file}/><span>{n.table.source||'Unknown mapping source'}</span></div>)}</div></Block>}
    </>;
}
function ApiExplorer({result,onNavigate,onContextSelect,focusFile}){
    const all=asArray(result?.apiEndpoints),[selected,setSelected]=useState(null),[graphSelected,setGraphSelected]=useState(null),[method,setMethod]=useState('ALL'),[query,setQuery]=useState('');
    const methods=['ALL',...new Set(all.map(a=>a.method).filter(Boolean))];
    const filtered=all.map((v,i)=>({v,i})).filter(({v})=>(method==='ALL'||v.method===method)&&`${v.method} ${v.path} ${v.file}`.toLowerCase().includes(query.toLowerCase()));
    const ep=filtered.find(({i})=>i===selected)?.v
        ||(focusFile?filtered.find(({v})=>v.file===focusFile)?.v:null)
        ||filtered[0]?.v;const graph=useMemo(()=>makeApiGraph(result,ep),[result,ep]);
    return <><Header title="API Explorer" description="Discovered routes, API declarations and source-backed outgoing dependencies."/><div className="ws-info">Static route discovery may miss dynamic or unsupported framework registrations. Authentication markers are local heuristics, not security guarantees.</div><Metrics items={[["Discovered endpoints",all.length],["Frameworks",Array.isArray(result?.apiEndpoints)?new Set(all.map(e=>e.framework).filter(Boolean)).size:null],["API client operations",asArray(result?.apiContractAnalysis?.clientCalls).length||null]]}/>
    <div className="ws-two"><Block title="Endpoint inventory"><div className="ws-controls"><input className="ws-input" aria-label="Search API endpoints" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search path, method or file…"/><select className="ws-select" value={method} onChange={e=>setMethod(e.target.value)} aria-label="Filter HTTP method">{methods.map(m=><option key={m}>{m}</option>)}</select></div><div className="ws-list ws-scroll-list">{filtered.map(({v,i})=><button className={`ws-list-item ${ep===v?'selected':''}`} key={`${i}-${v.path}`} onClick={()=>{setSelected(i);if(v.file)onContextSelect?.({file:v.file,line:v.line});}}><span className={`ws-method ${v.method||'OTHER'}`}>{v.method||'ROUTE'}</span><strong>{v.path||'Path unknown'}</strong><span>{v.framework||''}</span></button>)}{!filtered.length&&<Empty>No matching endpoints. This may reflect extraction or filtering limits.</Empty>}</div></Block><Block title="Endpoint details">{ep?<><div className="ws-chips"><span className={`ws-method ${ep.method||''}`}>{ep.method||'ROUTE'}</span><strong>{ep.path||'Unknown path'}</strong></div><div className="ws-info"><span>Framework: {ep.framework||'not determined'}</span></div><Evidence file={ep.file} line={ep.line}/><p>Auth: {ep.authProtected?'Nearby authorization signal detected':'No nearby authorization signal detected'} — global security may differ.</p><p className="ws-small">{ep.confidenceReason||'Endpoint discovered from source patterns.'}</p><div className="ws-chips"><button className="ws-btn" onClick={()=>onNavigate("call-graph",{file:ep.file})}>Inspect related function calls <ArrowRight size={13}/></button><button className="ws-btn" onClick={()=>onNavigate("ai-preview",{file:ep.file})}>Ask AI about this endpoint <ArrowRight size={13}/></button></div></>:<Empty>No route declarations extracted.</Empty>}</Block></div>
    <Block title="Endpoint dependency graph"><SourceDiagram nodes={graph.nodes} edges={graph.edges} selected={graphSelected} onSelect={setGraphSelected} title="Route and its resolved outgoing dependencies"/>
        {graph.nodes.some(n=>n.id===graphSelected)&&<div className="ws-graph-selection"><strong>{graph.nodes.find(n=>n.id===graphSelected)?.label}</strong><Evidence file={graph.nodes.find(n=>n.id===graphSelected)?.file||ep?.file} line={graph.nodes.find(n=>n.id===graphSelected)?.line||ep?.line}/></div>}
        <p className="ws-small">Only the selected endpoint's source file and directly resolved outgoing dependencies are shown; this is not a verified runtime request sequence.</p></Block></>;
}
function CallGraphExplorer({result,onNavigate,focusFile}){
    const graph=useMemo(()=>makeCallGraph(result),[result]),[query,setQuery]=useState(''),[selected,setSelected]=useState(null);
    const found=graph.nodes.find(n=>n.id===selected)||graph.nodes.find(n=>focusFile&&n.file===focusFile)||graph.nodes[0]||null;
    const related=found?graph.edges.filter(x=>x.source===found.id||x.target===found.id):[];
    const focus=found?new Set([found.id,...related.flatMap(x=>[x.source,x.target])]):new Set();
    return <><Header title="Call Graph" description="Trace resolved caller-to-callee relationships and possible change impact."/><div className="ws-info">Static function-call extraction only; unresolved and ambiguous calls are not drawn as confirmed edges.</div><Metrics items={[["Resolved function nodes",graph.nodes.length],["Resolved call sites",graph.edges.length],["Unresolved calls",graph.unresolved],["Ambiguous calls",graph.ambiguous]]}/><div className="ws-two"><Block title="Function navigator"><input className="ws-input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a function or file…" aria-label="Search functions"/><div className="ws-list ws-scroll-list">{graph.nodes.filter(n=>`${n.label} ${n.file}`.toLowerCase().includes(query.toLowerCase())).slice(0,200).map(n=><div key={n.id} className={`ws-list-item ${found?.id===n.id?'selected':''}`}><button className="ws-row-select" onClick={()=>setSelected(n.id)}><Code2 size={15}/><strong>{n.label}</strong></button><Evidence file={n.file} line={n.line}/></div>)}{!graph.nodes.length&&<Empty>No attributed resolved function calls were found. Look at call-graph coverage and diagnostics.</Empty>}</div></Block><Block title={found?`Selected function: ${found.label}`:'Function details'}>{found?<><Evidence file={found.file} line={found.line}/><h3>Incoming callers</h3><div className="ws-list">{related.filter(e=>e.target===found.id).map((x,i)=><button key={i} className="ws-list-item" onClick={()=>setSelected(x.source)}>{graph.nodes.find(n=>n.id===x.source)?.label||x.source}</button>)}{!related.some(e=>e.target===found.id)&&<Empty>No resolved incoming calls.</Empty>}</div><h3>Outgoing calls</h3><div className="ws-list">{related.filter(e=>e.source===found.id).map((x,i)=><button key={i} className="ws-list-item" onClick={()=>setSelected(x.target)}>{graph.nodes.find(n=>n.id===x.target)?.label||x.target} · call site line {x.site??'unknown'}</button>)}{!related.some(e=>e.source===found.id)&&<Empty>No resolved outgoing calls.</Empty>}</div></>:<Empty>Select a source-backed function.</Empty>}</Block></div><Block title="Local call graph"><SourceDiagram nodes={graph.nodes.filter(n=>focus.has(n.id))} edges={related} selected={found?.id} onSelect={setSelected} title="Selected function and immediate calls"/><p className="ws-small">Use the navigator to traverse the graph; cycles are represented only if resolved call evidence exists.</p></Block></>;
}
function SecurityCenter({result,onNavigate}){
    const findings=asArray(result?.securityIssues),[query,setQuery]=useState(''),[severity,setSeverity]=useState('ALL'),[selected,setSelected]=useState(0),[reviews,setReviews]=useState({});
    const levels=[...new Set(findings.map(riskLevel))];
    const filtered=findings.map((f,i)=>({f,i})).filter(({f})=>(severity==='ALL'||riskLevel(f)===severity)&&`${f.title} ${f.name} ${f.file} ${f.description}`.toLowerCase().includes(query.toLowerCase()));
    const active=filtered.find(x=>x.i===selected)?.f||filtered[0]?.f;const activeIndex=filtered.find(x=>x.i===selected)?.i??filtered[0]?.i;const loc=active?findingLocation(active):{};
    return <><Header title="Security Center" description="Inspect detected security patterns, locations and evidence without claiming runtime exploitability."/><div className="ws-info">Security findings are scanner-reported candidates. Absence of findings does not establish vulnerability-free code.</div><Metrics items={[["Security findings",Array.isArray(result?.securityIssues)?findings.length:null],["Reviewed this session",Object.values(reviews).filter(x=>x!=='needs-review').length],["Source coverage",result?.analysisCoverage?.security?.status||result?.analysisCoverage?.status||'Unknown']]}/>
    <Block title="Security signals · visual summary"><SecurityVisuals result={result} selectedIndex={activeIndex} onSelect={setSelected}/></Block>
    <div className="ws-two"><Block title="Security findings"><div className="ws-controls"><input className="ws-input" aria-label="Search security findings" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search findings…"/><select className="ws-select" aria-label="Severity filter" value={severity} onChange={e=>setSeverity(e.target.value)}><option value="ALL">All severity levels</option>{levels.map(x=><option value={x} key={x}>{x}</option>)}</select></div><div className="ws-list ws-scroll-list">{filtered.map(({f,i})=>{const spot=findingLocation(f);return <div key={f.id||i} className={`ws-list-item ${active===f?'selected':''}`}><button className="ws-row-select" onClick={()=>setSelected(i)}><span className={`ws-pill ${['critical','high'].includes(riskLevel(f))?'bad':'warn'}`}>{riskLevel(f)}</span><strong>{f.title||f.name||f.type||'Finding'}</strong></button><Evidence file={spot.path} line={spot.line}/></div>})}{!filtered.length&&<Empty>No matching security findings. Check coverage before interpreting this as a clean result.</Empty>}</div></Block>
    <Block title="Finding details">{active?<><h3>{active.title||active.name||active.type||'Finding'}</h3><div className="ws-chips"><span className="ws-pill">{riskLevel(active)}</span><span className="ws-pill">{reviews[activeIndex]||'needs-review'}</span></div><Evidence file={loc.path} line={loc.line}/><p>{active.desc||active.description||active.confidenceReason||'Review the source and diagnostic evidence.'}</p>{sensitivePath(loc.path)?<div className="ws-info">Sensitive file: source excerpt suppressed to avoid exposing secrets.</div>:null}<p className="ws-small">Review choices below are local to this UI session and do not alter findings or source files.</p><div className="ws-chips"><button className="ws-btn" onClick={()=>setReviews(v=>({...v,[activeIndex]:'confirmed'}))}>Confirm</button><button className="ws-btn" onClick={()=>setReviews(v=>({...v,[activeIndex]:'false-positive'}))}>False positive</button><button className="ws-btn" onClick={()=>setReviews(v=>({...v,[activeIndex]:'needs-review'}))}>Needs review</button></div></>:<Empty>Select a detected finding to review evidence.</Empty>}</Block></div>
    <Block title="Related source signals"><div className="ws-chips"><span className="ws-pill">Authentication and access checks</span><span className="ws-pill">Configuration patterns</span><span className="ws-pill">Literal source-to-sink leads</span></div><p className="ws-small">Security signals are scoped to what the Analysis Engine actually extracted; runtime access controls and vulnerabilities are not inferred from missing annotations.</p><Jump label="Review code quality" to="quality" onNavigate={onNavigate}/></Block></>;
}
function QualityCenter({result,onNavigate,focusFile}){
    const files=asArray(result?.files),[query,setQuery]=useState(''),[selected,setSelected]=useState(null);
    const ranking=files.filter(f=>Number.isFinite(f?.complexity?.score)).sort((a,b)=>b.complexity.score-a.complexity.score);
    const listed=files.filter(f=>f.path?.toLowerCase().includes(query.toLowerCase()));
    const file=files.find(f=>f.path===selected)||files.find(f=>f.path===focusFile)||ranking[0]||files[0];
    const issues=asArray(result?.issues),duplicates=asArray(result?.duplicates),patterns=asArray(result?.patterns);
    const max=Math.max(1,...ranking.map(f=>f.complexity.score));
    return <><Header title="Code Quality" description="Complexity, source metrics, duplicate candidates and maintainability signals."/><div className="ws-info">All quality measures are static/heuristic where indicated. Missing complexity is not assigned a fake score.</div><Metrics items={[["Files",files.length],["Complexity measured",ranking.length],["Issue groups",issues.length],["Duplicate candidates",duplicates.length],["Detected patterns",patterns.length]]}/>
    <Block title="Complexity & source dependency landscape"><QualityVisuals result={result} selectedPath={file?.path} onSelect={setSelected}/></Block>
    <div className="ws-two"><Block title="File quality inspector"><input className="ws-input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search files…" aria-label="Search quality files"/><div className="ws-list ws-scroll-list">{listed.slice(0,200).map(f=><button key={f.path} onClick={()=>setSelected(f.path)} className={`ws-list-item ${file?.path===f.path?'selected':''}`}><FileCode2 size={15}/><strong>{f.path.split('/').pop()}</strong><span>{Number.isFinite(f.complexity?.score)?`Complexity ${f.complexity.score}`:'Not measured'}</span></button>)}</div></Block><Block title="File details">{file?<><Evidence file={file.path}/><div className="ws-kv"><span>Language</span><strong>{file.language||'Unknown'}</strong><span>Lines</span><strong>{format(file.loc)}</strong><span>Functions</span><strong>{format(file.functionCount)}</strong><span>Complexity estimate</span><strong>{format(file.complexity?.score)}</strong><span>Layer (inferred)</span><strong>{file.layer||'Not classified'}</strong></div></>:<Empty>No source files extracted.</Empty>}<Jump label="Review modernization" to="migrate" onNavigate={onNavigate}/></Block></div>
    <div className="ws-two"><Block title="Quality / architecture issues"><div className="ws-list ws-scroll-list">{issues.map((i,k)=><div key={k} className="ws-list-item"><strong>{i.title||i.name||i.type||'Issue'}</strong><span>{i.desc||i.description||'See source-backed issue records.'}</span>{asArray(i.items).map((item,j)=>{const file=item.file||item.path;return file?<EyeSource key={j} file={file} line={item.line} compact/>:null;}).slice(0,3)}</div>)}{!issues.length&&<Empty>No issue groups reported.</Empty>}</div></Block><Block title="Duplicate & pattern findings"><div className="ws-list ws-scroll-list">{duplicates.map((d,i)=><div className="ws-list-item" key={`d${i}`}><strong>{d.name||d.type||'Duplicate candidate'}</strong><span>{asArray(d.files).length} locations</span>{asArray(d.files).map((spot,j)=>{const path=typeof spot==='string'?spot:spot.path||spot.file;return path?<EyeSource key={j} file={path} line={spot.line} compact/>:null;}).slice(0,3)}</div>)}{patterns.map((p,i)=><div className="ws-list-item" key={`p${i}`}><strong>{p.name||'Pattern'}</strong><span>{asArray(p.files).length} source files</span>{asArray(p.files).map((spot,j)=>{const path=typeof spot==='string'?spot:spot.path||spot.file;return path?<EyeSource key={j} file={path} line={spot.line} compact/>:null;}).slice(0,3)}</div>)}{!duplicates.length&&!patterns.length&&<Empty>No duplication/pattern records reported.</Empty>}</div></Block></div></>;
}
function MlInsights({result}){
    const candidate=result?.mlFeatureDataset||result?.mlFeatures||result?.ml?.dataset||null;
    const fileRows=asArray(candidate?.fileFeatures||candidate?.file_features||candidate?.files);
    const fnRows=asArray(candidate?.functionFeatures||candidate?.function_features||candidate?.functions);
    return <><Header title="ML Insights" description="Model-ready datasets and validated inference results, only when actually available."/><div className="ws-info">Phase 0 is an optional foundation: no model scores or predictions are invented. This page reports only connected dataset/model metadata.</div><Metrics items={[["File feature rows",candidate?fileRows.length:null],["Function feature rows",candidate?fnRows.length:null],["Dataset schema",candidate?.schemaVersion||candidate?.schema_version||'Unavailable'],["Model predictions",null]]}/>
    <Block title="ML feature foundation">{candidate?<><div className="ws-kv"><span>Dataset ID</span><strong>{candidate.datasetId||candidate.dataset_id||'Unavailable'}</strong><span>Revision</span><strong>{candidate.revision||candidate.commit||'Unavailable'}</strong><span>Schema version</span><strong>{candidate.schemaVersion||candidate.schema_version||'Unavailable'}</strong></div><p>Connected file rows: {fileRows.length}. Connected function rows: {fnRows.length}.</p></>:<Empty>No ML feature dataset is attached to this analysis snapshot. Run and verify the Phase 0 pipeline separately before connecting it here.</Empty>}</Block>
    {candidate&&<Block title="Connected feature rows · source inspection"><div className="ws-list ws-scroll-list">{[...fileRows.slice(0,40),...fnRows.slice(0,40)].map((row,i)=>{
        const path=row.path||row.file||row.file_path||row.source_path;
        return <div className="ws-list-item" key={i}><strong>{path||row.name||row.function||'Feature row without source path'}</strong><span>{path&&<EyeSource file={path} line={row.line} compact/>}</span></div>;
    })}</div></Block>}
    <Block title="Model registry and predictions"><Empty>No validated ML model registry/prediction payload is connected. Anomaly detection, failure probabilities and feature importance will appear only after real training/inference and evaluation are implemented.</Empty></Block></>;
}
function WorkflowStudio({result,section,repositoryId,onNavigate,onExitRepository,focusFile}){
    if (section === 'tests') {
        return <TestingStudio result={result} focusFile={focusFile}>
            <TestsPage embedded analysisResult={result} activeWorkspace="tests" onNavigate={onNavigate} onExitRepository={onExitRepository}/>
        </TestingStudio>;
    }
    return <ModernizationStudio result={result} focusFile={focusFile}>
        <MigratePage embedded repositoryId={repositoryId} analysisResult={result} activeWorkspace="migrate" onNavigate={onNavigate} onExitRepository={onExitRepository}/>
    </ModernizationStudio>;
}

function exportName(name){return (String(name||'repository').replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'')||'repository');}
// Small, read-only Java backend reachability indicator for the shared top navigation.
// A successful repository-list GET proves the browser can reach the configured backend;
// it does NOT confirm AI-service health or that an earlier ingest was successful.
function useBackendReachability() {
    const [connection, setConnection] = useState({ state: 'checking', reason: 'Checking backend…' });
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        let mounted = true;
        let activeRequest = null;
        const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
        async function check() {
            activeRequest?.abort();
            const controller = new AbortController();
            activeRequest = controller;
            const timeout = window.setTimeout(() => controller.abort(), 4500);
            try {
                const response = await fetch(`${apiBase}/api/repository/list`, {
                    method: 'GET', cache: 'no-store', signal: controller.signal,
                });
                if (mounted && activeRequest === controller) {
                    setConnection(response.ok
                        ? { state: 'online', reason: 'Java backend API is reachable.' }
                        : { state: 'offline', reason: `Backend API returned HTTP ${response.status}.` });
                }
            } catch (error) {
                if (mounted && activeRequest === controller) {
                    setConnection({ state: 'offline', reason: error?.name === 'AbortError'
                        ? 'Backend connection timed out.' : 'Backend API could not be reached.' });
                }
            } finally {
                window.clearTimeout(timeout);
            }
        }
        check();
        const interval = window.setInterval(check, 30000);
        return () => { mounted = false; window.clearInterval(interval); activeRequest?.abort(); };
    }, [refresh]);
    return [connection, () => { setConnection({ state: 'checking', reason: 'Checking backend…' }); setRefresh(v => v + 1); }];
}
export default function WorkspaceDashboard({analysisResult,repoMeta,repositoryId,activeWorkspace='dashboard',onNavigate,onExitRepository,onSettings,ingestWarning}){
    const [collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false),[search,setSearch]=useState(''),[exporting,setExporting]=useState(false),[exportError,setExportError]=useState(''),[confirmExit,setConfirmExit]=useState(false),[selectionContext,setSelectionContext]=useState(null);
    const [backendConnection, refreshBackendConnection] = useBackendReachability();
    const backendLabel = backendConnection.state === 'online' ? 'Backend connected' :
        backendConnection.state === 'offline' ? 'Backend unavailable' : 'Checking backend';
    const backendTooltip = `${backendLabel}. ${backendConnection.reason} Java backend only; AI service is checked separately.${ingestWarning ? ` Previous ingestion warning: ${ingestWarning}` : ''} Click to refresh.`;
    // Source context is local to the selected repository snapshot. It is not persisted across repositories.
    const availablePaths=useMemo(()=>sourcePathSet(analysisResult),[analysisResult]);
    const focusFile=(input)=>{
        const focus=normalizeWorkspaceContext(input,availablePaths);
        if(focus){setSelectionContext(focus);rememberWorkspaceFocus(repositoryId,focus,availablePaths);}
        return focus;
    };
    useEffect(()=>{setSelectionContext(recallWorkspaceFocus(repositoryId,availablePaths));},[repositoryId]);
    useEffect(()=>{setSelectionContext(previous=>previous?normalizeWorkspaceContext(previous,availablePaths):recallWorkspaceFocus(repositoryId,availablePaths));},[availablePaths,repositoryId]);
    const section= NAV_MAP.has(activeWorkspace)?activeWorkspace:'dashboard';
    useEffect(()=>{setMobile(false);},[section]);
    const jump=(key,context=null)=>{
        // Sidebar navigation never erases the current file. Explicit invalid contexts are ignored.
        if(context?.file)focusFile(context);
        onNavigate(key,context);
        setMobile(false);
    };
    const exportAnalysis=async()=>{
        if(exporting)return;
        if(typeof window!=='undefined' && !window.confirm('This export includes raw repository source and may contain API keys, passwords or other credentials. Keep it private. Continue?'))return;
        setExportError('');setExporting(true);
        try {
            const text=typeof Worker!=='undefined'?await runWorker(ExportWorker,{analysisResult:analysisResult||{},repoMeta}):toWorkspaceAnalysisSourceJson(analysisResult||{},repoMeta);
            const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
            const a=document.createElement('a');a.href=url;a.download=`${exportName(repoMeta?.name||analysisResult?.repository?.name)}-analysis-with-source.json`;
            document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
        } catch(error){setExportError(error.message||'Could not export analysis data.');}finally{setExporting(false)}
    };
    const content={
        dashboard:<Overview result={analysisResult} repoMeta={repoMeta} onNavigate={jump} onExport={exportAnalysis} exporting={exporting} onContextSelect={focusFile} focusFile={selectionContext?.file}/>,
        'visualization-preview':<ExplorerV2Boundary type="visualization" resetKey={repositoryId} onNavigate={jump}><VisualizationExplorerV2 analysisResult={analysisResult} activeWorkspace="visualization-preview" onNavigate={jump} focusFile={selectionContext?.file} onContextSelect={focusFile}/></ExplorerV2Boundary>,
        'ai-preview':<ExplorerV2Boundary type="ai" resetKey={repositoryId} onNavigate={jump}><AiExplorerV2 analysisResult={analysisResult} repositoryId={repositoryId} focusedContext={selectionContext?.file?{selectedNode:selectionContext.file}:null} onNavigate={jump} onContextSelect={focusFile}/></ExplorerV2Boundary>,
        architecture:<Architecture result={analysisResult} onNavigate={jump} focusFile={selectionContext?.file}/>,
        database:<DatabaseExplorer result={analysisResult} onNavigate={jump} onContextSelect={focusFile} focusFile={selectionContext?.file}/>,
        api:<ApiExplorer result={analysisResult} onNavigate={jump} onContextSelect={focusFile} focusFile={selectionContext?.file}/>,
        'call-graph':<CallGraphExplorer result={analysisResult} onNavigate={jump} focusFile={selectionContext?.file}/>,
        security:<SecurityCenter result={analysisResult} onNavigate={jump}/>,
        quality:<QualityCenter result={analysisResult} onNavigate={jump} focusFile={selectionContext?.file}/>,
        'ml-insights':<MlInsights result={analysisResult}/>,
        tests:<WorkflowStudio result={analysisResult} section="tests" repositoryId={repositoryId} onNavigate={jump} onExitRepository={onExitRepository} focusFile={selectionContext?.file}/>,
        migrate:<WorkflowStudio result={analysisResult} section="migrate" repositoryId={repositoryId} onNavigate={jump} onExitRepository={onExitRepository} focusFile={selectionContext?.file}/>,
    };
    return <SourceProvider result={analysisResult} onSourceOpen={(file,line)=>focusFile({file,line})}><div className="ws-shell">
        <header className="ws-top"><button className="ws-icon-btn ws-mobile-menu" onClick={()=>setMobile(v=>!v)} aria-label="Toggle workspace menu"><Menu size={19}/></button><span className="ws-mark"><Boxes size={17}/></span><strong className="ws-brand">AI Legacy Bridge</strong><span className="ws-top-repo" title={repoMeta?.name||''}>/ {repoMeta?.name||analysisResult?.repository?.name||'Repository'}</span><div className="ws-top-spacer"/><button type="button" className={`ws-backend-status is-${backendConnection.state}`} onClick={refreshBackendConnection} title={backendTooltip} aria-label={`${backendLabel}. Click to check again.`}><span className="ws-backend-dot" aria-hidden="true"/><span className="ws-backend-text">Backend</span></button><button className="ws-icon-btn" onClick={()=>onSettings?.()} title="Settings" aria-label="Settings"><Settings size={17}/></button><button className="ws-icon-btn" onClick={()=>setCollapsed(v=>!v)} title="Toggle sidebar" aria-label="Toggle sidebar"><PanelLeftClose size={17}/></button></header>
        <div className="ws-body"><aside className={`ws-sidebar ${collapsed?'collapsed':''} ${mobile?'mobile-open':''}`} aria-label="Workspace navigation"><div className="ws-sidebar-content"><label className="ws-sidebar-search"><Search size={14}/>{!collapsed&&<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find a page…" aria-label="Search workspace pages"/>}</label>{NAV.map(group=><div className="ws-nav-group" key={group.group}>{!collapsed&&<span className="ws-group-label">{group.group}</span>}{group.pages.filter(([,name])=>name.toLowerCase().includes(search.toLowerCase())).map(([id,name,Icon])=><button key={id} title={name} className={`ws-nav-item ${section===id?'is-active':''}`} onClick={()=>jump(id)}><Icon size={16}/>{!collapsed&&<span>{name}</span>}</button>)}</div>)}<div className="ws-nav-separator"/>{!collapsed&&<span className="ws-group-label">LEGACY FALLBACK</span>}
                <button className="ws-nav-item" title="Original Visualization Explorer" onClick={()=>jump('visualization')}><Network size={16}/>{!collapsed&&<span>Original Visualization</span>}</button>
                <button className="ws-nav-item" title="Original AI Explorer" onClick={()=>jump('ai-explorer')}><MessageSquare size={16}/>{!collapsed&&<span>Original AI Explorer</span>}</button>
                <div className="ws-nav-separator"/><button className="ws-nav-item" onClick={()=>onSettings?.()}><Settings size={16}/>{!collapsed&&<span>Settings</span>}</button>{confirmExit?<div className="ws-exit-confirm"><span>Exit this repository?</span><button className="ws-btn danger" onClick={()=>{forgetWorkspaceFocus(repositoryId);onExitRepository()}}>Exit</button><button className="ws-btn" onClick={()=>setConfirmExit(false)}>Cancel</button></div>:<button className="ws-nav-item" onClick={()=>setConfirmExit(true)}><LogOut size={16}/>{!collapsed&&<span>Exit Repository</span>}</button>}</div></aside>
        {mobile&&<button className="ws-mobile-backdrop" onClick={()=>setMobile(false)} aria-label="Close workspace menu"/>}
        <main className="ws-main" key={section}><div className={`ws-content ${section==='visualization-preview'||section==='ai-preview'?'ws-content--explorer':''}`}>
            {selectionContext?.file&&<div className="ws-context-bar" role="region" aria-label="Selected repository source context">
                <div className="ws-context-label"><FileCode2 size={16}/><div><span>FOCUSED SOURCE</span><strong title={selectionContext.file}>{selectionContext.file}{selectionContext.line?`:${selectionContext.line}`:''}</strong></div></div>
                <div className="ws-context-actions"><EyeSource file={selectionContext.file} line={selectionContext.line} compact/>
                    <button className="ws-btn" onClick={()=>jump('call-graph')}>Call Graph</button>
                    <button className="ws-btn" onClick={()=>jump('quality')}>Quality</button>
                    <button className="ws-btn" onClick={()=>jump('ai-preview',selectionContext)}>Ask AI</button>
                    <button className="ws-icon-btn" aria-label="Clear selected source context" title="Clear focused source" onClick={()=>{forgetWorkspaceFocus(repositoryId);setSelectionContext(null)}}><X size={16}/></button>
                </div>
            </div>}{exportError&&<div className="ws-alert"><AlertTriangle size={16}/>{exportError}<button className="ws-btn" onClick={()=>setExportError('')}>Dismiss</button></div>}{content[section]}</div></main></div>
    </div></SourceProvider>;
}
