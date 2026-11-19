import { useMemo, useState } from 'react';
import {
    AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, ClipboardCheck,
    Download, FileCode2, FlaskConical, GitBranch, GitCompare, Link2, Search,
    ShieldAlert, Sparkles, Workflow
} from 'lucide-react';
import InteractiveDiagram from './InteractiveDiagram.jsx';
import { EyeSource, SourceLocation } from './SourceViewer.jsx';
import { asArray } from './workspaceData.js';
import { testEvidenceModel, testLinkGraph, modernizationEvidenceModel, migrationNeighborhood } from './workflowModels.js';
import './WorkflowStudios.css';

const count = n => Number.isFinite(n) ? n.toLocaleString() : '—';
function Summary({items}) {
    return <div className="ws3-summary">{items.map(([label,value,hint],i) =>
        <div className="ws3-summary-card" key={`${label}:${i}`}><span>{label}</span><strong>{count(value)}</strong><small>{hint}</small></div>)}</div>;
}
function Frame({title,description,children,aside}) {
    return <section className="ws3-frame"><header className="ws3-frame-head"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{aside}</header>{children}</section>;
}
function Notice({children,kind=''}) {return <div className={`ws3-notice ${kind}`}><AlertTriangle size={16}/><span>{children}</span></div>;}
function Tabs({options,value,onChange}) {
    return <div className="ws3-tabs" role="tablist" aria-label="Studio views">{options.map(([id,label,Icon])=>
        <button key={id} role="tab" aria-selected={value===id} className={value===id?'is-on':''} onClick={()=>onChange(id)}><Icon size={16}/>{label}</button>)}</div>;
}
function Empty({children}){return <div className="ws3-empty">{children}</div>;}
function EyeLocation({file,line}) {return <span className="ws3-code-ref"><SourceLocation file={file} line={line}/></span>;}

/** Everything here is a view over testLinkage. Source links never claim test coverage. */
export function TestingStudio({result,children,focusFile}) {
    const model = useMemo(()=>testEvidenceModel(result),[result]);
    const [tab,setTab] = useState('map');
    const [query,setQuery] = useState('');
    const [selected,setSelected] = useState(()=>focusFile&&model.links.some(link=>link.sourceFile===focusFile)?`src:${focusFile}`:null);
    const graph = useMemo(()=>testLinkGraph(model,{query,maxLinks:100}),[model,query]);
    const focusedLink = selected ? model.links.filter(link => selected === `src:${link.sourceFile}` || selected === `test:${link.testFile}`) : [];
    const selectedLabel=selected?.startsWith('src:')?selected.slice(4):selected?.startsWith('test:')?selected.slice(5):null;
    const visibleLinks=model.links.filter(link=>`${link.sourceFile} ${link.testFile}`.toLowerCase().includes(query.trim().toLowerCase()));
    const functionLinks=model.functionLinks.filter(link=>`${link.sourceFile} ${link.testFile} ${link.sourceFunction||''} ${link.testFunction||''}`.toLowerCase().includes(query.trim().toLowerCase()));
    return <div className="ws3-studio" data-testid="testing-studio-v3">
        <div className="ws3-title"><div className="ws3-title-mark"><FlaskConical size={22}/></div><div><span className="ws3-kicker">TEST INTELLIGENCE</span><h1>Testing Studio</h1><p>Understand source-to-test relationships first. Generate test drafts using the original working tool.</p></div></div>
        <Notice>Static test links are evidence of imports, naming or call sites—not proof of assertions, executed tests, passing status or runtime coverage.</Notice>
        <Summary items={[
            ['Detected test files',model.testFileCount,'From analysis snapshot'],
            ['Source / test links',model.totalLinkRecords,'Heuristic relationships'],
            ['Linked test files',model.linkedTestFileCount,'Not runtime coverage'],
            ['Function call links',Array.isArray(result?.testLinkage?.functionLinks)?model.functionLinks.length:null,'Static call evidence'],
        ]}/>
        <Tabs options={[["map","Traceability Map",GitBranch],["functions","Function Evidence",FileCode2],["tools","Test Generator & Tools",Sparkles]]} value={tab} onChange={setTab}/>
        <div hidden={tab!=='map'} className="ws3-view">
            <div className="ws3-columns">
                <Frame title="Source ↔ Test map" description="Select a node to inspect its original source and test relationships." aside={<span className="ws3-tag">Source-derived links</span>}>
                    <div className="ws3-filter"><Search size={14}/><input aria-label="Filter source and test links" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search source or test file…"/></div>
                    {!model.available?<Empty>Test-linkage analysis was not included in this snapshot.</Empty>:
                      <><InteractiveDiagram key="testing-map" title="Source-to-test links" nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={setSelected} maxInitial={80}/>
                        {graph.truncated&&<p className="ws3-footnote">Displaying {graph.shown} of {graph.matching} matching links. Filter by file for a focused view.</p>}
                        <p className="ws3-footnote">Direction represents the recorded source/test association. It is not an observed runtime call sequence.</p></>}
                </Frame>
                <Frame title={selectedLabel?'Selected source evidence':'Linked files'} description={selectedLabel?'Inspect both ends of the selected relationship.':'Use the map or choose a source file.'}>
                    {selectedLabel&&<div className="ws3-selected"><strong>{selectedLabel}</strong><EyeSource file={selectedLabel} compact/></div>}
                    <div className="ws3-list ws3-scroll">
                        {(selectedLabel?focusedLink:visibleLinks).slice(0,80).map((link,i)=><div className="ws3-link-row" key={`${link.sourceFile}:${link.testFile}:${i}`}>
                            <div><span className="ws3-tag">{link.confidence} confidence · {link.relationship}</span><strong>Source</strong><EyeLocation file={link.sourceFile}/><strong>Test file</strong><EyeLocation file={link.testFile}/>
                                {link.evidence?.path&&<><strong>Link evidence</strong><EyeLocation file={link.evidence.path} line={link.evidence.line}/></>}</div>
                            <button className="ws3-arrow-btn" aria-label={`Select test ${link.testFile}`} onClick={()=>setSelected(`test:${link.testFile}`)}><ChevronRight size={16}/></button>
                        </div>)}
                        {!visibleLinks.length&&<Empty>{model.available?'No extracted source-to-test links match this view. This does not imply zero testing.':'Linkage data unavailable.'}</Empty>}
                        {visibleLinks.length>80&&!selectedLabel&&<p className="ws3-footnote">Showing first 80 records. Narrow your search for more.</p>}
                    </div>
                    <button className="ws3-main-btn" onClick={()=>setTab('tools')}>Open test generator <ArrowRight size={14}/></button>
                </Frame>
            </div>
            {!!model.unlinkedTestFiles.length&&<Frame title="Unlinked test candidates" description="These files had no detected source-file association; dynamic references may be missed.">
                <div className="ws3-compact-list">{model.unlinkedTestFiles.slice(0,45).map(file=><div key={file}><span>{file}</span><EyeSource file={file} compact/></div>)}</div>
                {model.unlinkedTestFiles.length>45&&<p className="ws3-footnote">Showing 45 of {model.unlinkedTestFiles.length} unlinked test files.</p>}
            </Frame>}
        </div>
        <div hidden={tab!=='functions'} className="ws3-view">
            <Frame title="Function-level test call evidence" description="Resolved call-site references between identified test and source functions.">
                <div className="ws3-filter"><Search size={14}/><input aria-label="Search function test evidence" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Filter function or source path…"/></div>
                {functionLinks.length?<div className="ws3-function-grid">{functionLinks.slice(0,150).map((link,i)=><div className="ws3-function-card" key={`${link.sourceFile}:${link.testFile}:${i}`}>
                    <div className="ws3-function-title"><span className="ws3-tag">{link.confidence} confidence</span><Link2 size={15}/></div>
                    <strong>{link.sourceFunction||'Source function name unavailable'}</strong><EyeLocation file={link.sourceFile} line={link.sourceLine}/>
                    <span className="ws3-call-arrow">Referenced from test ↓</span>
                    <strong>{link.testFunction||'Test function name unavailable'}</strong><EyeLocation file={link.testFile} line={link.callSiteLine||link.testFunctionLine}/>
                </div>)}</div>:<Empty>{model.available?'No resolved function-to-test call evidence. This is not a statement about runtime coverage.':'Test function linkage unavailable.'}</Empty>}
                {functionLinks.length>150&&<p className="ws3-footnote">Displaying 150 records. Search to narrow the list.</p>}
            </Frame>
        </div>
        <div hidden={tab!=='tools'} className="ws3-view ws3-tools">
            <Frame title="Original test generation & inspection" description="The existing Unit Tests, Test Linkage and API Endpoints tools run here unchanged.">
                <div className="ws3-preserved"><CheckCircle2 size={16}/> Original AI generation, editable draft, download and safe backend connection check remain available.</div>
                <div className="ws-workflow" data-testid="testing-workflow">{children}</div>
            </Frame>
        </div>
    </div>;
}

const riskColor = level => ['critical','high'].includes(String(level).toLowerCase())?'is-high':String(level).toLowerCase()==='medium'?'is-medium':'is-low';
function saveReviewPlan(files,model){
    if(!files.length)return;
    const known=new Map(model.riskRows.map(row=>[row.file,row]));
    const batch=new Map(model.batches.flatMap(x=>x.files.map(row=>[row.file,row.batch])));
    const report={schemaVersion:1,kind:'manual-migration-review-plan',semantics:'User-selected planning list only. Nothing was migrated, tested, approved or applied.',
        files:files.map(file=>({file,heuristicRisk:known.get(file)?.score??null,riskLevel:known.get(file)?.level??null,suggestedBatch:batch.get(file)??null}))};
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download='legacy-bridge-migration-review-plan.json';document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
/** Full migration advisor is still present; new views only project existing migrationRisk/order/dependencies. */
export function ModernizationStudio({result,children,focusFile}) {
    const model=useMemo(()=>modernizationEvidenceModel(result),[result]);
    const [tab,setTab]=useState('risk');
    const [query,setQuery]=useState('');
    const [file,setFile]=useState(()=>focusFile&&(model.riskRows.some(row=>row.file===focusFile)||model.batches.some(batch=>batch.files.some(row=>row.file===focusFile)))?focusFile:'');
    const [reviewSet,setReviewSet]=useState([]);
    const selected=file||model.riskRows[0]?.file||model.batches[0]?.files[0]?.file||'';
    const selectedRisk=model.riskRows.find(row=>row.file===selected);
    const filtered=model.riskRows.filter(row=>row.file.toLowerCase().includes(query.trim().toLowerCase()));
    const graph=useMemo(()=>migrationNeighborhood(model,result,selected,75),[model,result,selected]);
    const batches=model.batches;
    const toggle = path => setReviewSet(current=>current.includes(path)?current.filter(x=>x!==path):[...current,path]);
    return <div className="ws3-studio" data-testid="modernization-studio-v3">
        <div className="ws3-title"><div className="ws3-title-mark"><GitCompare size={22}/></div><div><span className="ws3-kicker">MODERNIZATION INTELLIGENCE</span><h1>Modernization Studio</h1><p>Trace source dependencies, inspect heuristic risk and prepare a non-destructive review plan.</p></div></div>
        <Notice>Migration risk is an estimate. Suggested batch order is derived from the static dependency graph and must be independently validated; this workspace never modifies source files.</Notice>
        <Summary items={[
            ['Files with estimated risk',model.riskAvailable?model.riskRows.length:null,'Heuristic ranking only'],
            ['Suggested batches',model.orderAvailable?batches.length:null,'Not an approved schedule'],
            ['Cycle-marked batches',model.orderAvailable?batches.filter(x=>x.hasCycle).length:null,'Require manual review'],
            ['My review list',reviewSet.length,'Temporary, not applied'],
        ]}/>
        <Tabs options={[["risk","Risk & Dependencies",ShieldAlert],["batches","Migration Batches",Workflow],["tools","Migration Advisor & AI",Sparkles]]} value={tab} onChange={setTab}/>
        <div hidden={tab!=='risk'} className="ws3-view">
            <div className="ws3-columns">
                <Frame title="Source files by estimated risk" description="Scores come from existing Analysis Engine output.">
                    <div className="ws3-filter"><Search size={14}/><input aria-label="Search migration risk files" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Filter file path…"/></div>
                    <div className="ws3-list ws3-scroll">{filtered.slice(0,160).map(row=><div key={row.file} className={`ws3-risk-row ${selected===row.file?'is-selected':''}`}>
                        <button onClick={()=>setFile(row.file)}><strong>{row.file.split('/').at(-1)}</strong><span title={row.file}>{row.file}</span></button>
                        <span className={`ws3-score ${riskColor(row.level)}`} title={row.reason||'Heuristic risk'}>{row.score==null?'—':row.score} · {row.level}</span>
                        <EyeSource file={row.file} compact/>
                    </div>)}
                    {!filtered.length&&<Empty>{model.riskAvailable?'No risk records match your search.':'Migration risk analysis unavailable in this snapshot.'}</Empty>}
                    {filtered.length>160&&<p className="ws3-footnote">Showing 160 risk rows. Filter to inspect other files.</p>}
                    </div>
                </Frame>
                <Frame title="Dependency impact explorer" description="Select any source file to inspect confirmed imported relationships.">
                    {selected?<><div className="ws3-selected"><strong>{selected}</strong><EyeSource file={selected} compact/></div>
                        <InteractiveDiagram key={selected} nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={setFile} title="Selected file dependency neighborhood" maxInitial={80}/>
                        {graph.truncated&&<p className="ws3-footnote">Showing 75 of {graph.totalNeighbors} direct source relationships; no edges were invented.</p>}
                        <div className="ws3-detail-block"><strong>Estimated migration risk</strong><span className={`ws3-score ${riskColor(selectedRisk?.level)}`}>{selectedRisk?.score??'—'} · {selectedRisk?.level||'unavailable'}</span>
                            <p>{selectedRisk?.reason||'Risk score not available for this source file.'}</p></div>
                        <button className="ws3-main-btn" onClick={()=>toggle(selected)}>{reviewSet.includes(selected)?'Remove from review list':'Add to review list'} <ArrowRight size={14}/></button>
                    </>:<Empty>No source-backed risk or migration batch file available to select.</Empty>}
                </Frame>
            </div>
        </div>
        <div hidden={tab!=='batches'} className="ws3-view">
            <div className="ws3-columns">
                <Frame title="Engine-proposed batch order" description="A dependency-based proposal; cycles are explicitly flagged.">
                    <div className="ws3-batches">{batches.map(batch=><section className="ws3-batch" key={batch.number}>
                        <h3>Batch {batch.number} <span className="ws3-tag">{batch.files.length} files</span>{batch.hasCycle&&<span className="ws3-score is-high">Cycle / manual review</span>}</h3>
                        {batch.files.slice(0,65).map(row=><div key={row.file} className="ws3-batch-file"><button onClick={()=>{setFile(row.file);setTab('risk')}}><ChevronRight size={14}/>{row.file}</button><EyeSource file={row.file} compact/><button className="ws3-add" onClick={()=>toggle(row.file)}>{reviewSet.includes(row.file)?'✓ Selected':'+ Review'}</button></div>)}
                        {batch.files.length>65&&<p className="ws3-footnote">Showing 65 of {batch.files.length} files in this batch.</p>}
                    </section>)}
                    {!batches.length&&<Empty>{model.orderAvailable?'No valid migration batches in this snapshot.':'Migration ordering is not available in this analysis snapshot.'}</Empty>}</div>
                </Frame>
                <Frame title="My review plan" description="Local selection only; no repository changes or approvals.">
                    <div className="ws3-review-head"><ClipboardCheck size={21}/><strong>{reviewSet.length} files selected for review</strong></div>
                    {reviewSet.length?<div className="ws3-compact-list">{reviewSet.map(path=><div key={path}><button className="ws3-minilink" onClick={()=>{setFile(path);setTab('risk')}}>{path}</button><EyeSource file={path} compact/><button aria-label={`Remove ${path}`} className="ws3-remove" onClick={()=>toggle(path)}>×</button></div>)}</div>:<Empty>Choose files from risk/dependency view or migration batches to prepare a manual review list.</Empty>}
                    <button className="ws3-main-btn" disabled={!reviewSet.length} onClick={()=>saveReviewPlan(reviewSet,model)}><Download size={15}/> Export review list (JSON)</button>
                    <p className="ws3-footnote">Export records your selected file paths and available heuristic risk/batch metadata. It never contains generated code or claims a migration happened.</p>
                </Frame>
            </div>
        </div>
        <div hidden={tab!=='tools'} className="ws3-view ws3-tools">
            <Frame title="Original migration scanner & AI advisor" description="Existing per-file review, real heuristic scan, AI suggestions and migration chat remain available.">
                <div className="ws3-preserved"><CheckCircle2 size={16}/> Source files remain read-only. Original migration functions are preserved.</div>
                <div className="ws-workflow" data-testid="modernization-workflow">{children}</div>
            </Frame>
        </div>
    </div>;
}
