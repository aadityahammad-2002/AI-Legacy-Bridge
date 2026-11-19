import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, Search, X } from 'lucide-react';
import { EyeSource, getSourceContent } from './SourceViewer.jsx';
import { asArray, safePath, sensitivePath } from './workspaceData.js';
import { buildFileTree, selectRepositoryFile } from './repositoryTree.js';
import { matchingRepositoryFiles } from './workspaceContext.js';


function FolderBranch({node,depth,expanded,toggle,selected,select,query}){
    const open=Boolean(expanded[node.path])||Boolean(query);
    const visible=(f)=>!query||f.path.toLowerCase().includes(query);
    const matches=(dir)=>dir.files.some(visible)||dir.children.some(matches);
    if(query&&!matches(node))return null;
    return <div className="ws-tree-branch">
        <button type="button" className="ws-tree-folder" style={{paddingLeft:Math.min(12+depth*14,110)}} onClick={()=>toggle(node.path)} aria-expanded={open}>
            {open?<ChevronDown size={13}/>:<ChevronRight size={13}/>} {open?<FolderOpen size={15}/>:<Folder size={15}/>}<span title={node.path}>{node.name}</span>
        </button>
        {open&&<div>
            {node.children.map(dir=><FolderBranch key={dir.path} node={dir} depth={depth+1} expanded={expanded} toggle={toggle} selected={selected} select={select} query={query}/>)}
            {node.files.filter(visible).map(f=><div className={`ws-tree-file ${selected===f.path?'selected':''}`} key={f.path} style={{paddingLeft:Math.min(25+(depth+1)*14,124)}}><button type="button" onClick={()=>select(f.path)} title={f.path}><FileCode2 size={14}/><span>{f.name}</span></button><EyeSource file={f.path} compact/></div>)}
        </div>}
    </div>;
}
export default function RepositoryExplorer({result,onNavigate,onContextSelect,focusFile=null}){
    const files=useMemo(()=>asArray(result?.files).filter(f=>safePath(f?.path)),[result]);
    const tree=useMemo(()=>buildFileTree(files),[files]);
    const [query,setQuery]=useState('');
    const [expanded,setExpanded]=useState({});
    const [selected,setSelected]=useState(null);
    const searchResults=useMemo(()=>matchingRepositoryFiles(files,query,240),[files,query]);
    const chooseFile=path=>{setSelected(path);onContextSelect?.({file:path});};
    // When used in the dashboard, the repository-scoped selection is the
    // source of truth. Local selection remains a fallback for standalone use.
    const active=selectRepositoryFile(files,focusFile,selected,typeof onContextSelect==='function');
    const content=active&&!sensitivePath(active.path)?getSourceContent(result,active.path):null;
    const funcs=asArray(result?.functions).filter(f=>f.file===active?.path);
    const classes=asArray(result?.classes).filter(c=>c.file===active?.path);
    const inbound=asArray(result?.dependencies).filter(d=>d.target===active?.path&&d.resolution==='resolved');
    const outbound=asArray(result?.dependencies).filter(d=>d.source===active?.path&&d.resolution==='resolved');
    const toggle=path=>setExpanded(s=>({...s,[path]:!s[path]}));
    return <div className="ws-repo-explorer">
        <div className="ws-repo-left">
            <div className="ws-repo-title"><strong>Repository files</strong><span>{files.length} files</span></div>
            <label className="ws-repo-search"><Search size={14}/><input aria-label="Search repository paths" placeholder="Search file or folder…" value={query} onChange={e=>setQuery(e.target.value.toLowerCase())}/>{query&&<button type="button" onClick={()=>setQuery('')} aria-label="Clear file search"><X size={13}/></button>}</label>
            <div className="ws-repo-tree" role="tree" aria-label="Repository files">
                {query ? <>
                    <div className="ws-search-status" role="status">{searchResults.total} matching file{searchResults.total===1?'':'s'}{searchResults.truncated?` · first ${searchResults.matches.length} shown`:''}</div>
                    {searchResults.matches.map(f=><div key={f.path} className={`ws-tree-file ${active?.path===f.path?'selected':''}`}>
                        <button type="button" onClick={()=>chooseFile(f.path)} title={f.path}><FileCode2 size={14}/><span>{f.path}</span></button><EyeSource file={f.path} compact/>
                    </div>)}
                    {!searchResults.total&&<div className="ws-empty">No matching repository files.</div>}
                </> : <>
                    {tree.children.map(d=><FolderBranch key={d.path} node={d} depth={0} expanded={expanded} toggle={toggle} selected={active?.path} select={chooseFile} query=""/>)}
                    {tree.files.map(f=><div key={f.path} className={`ws-tree-file ${active?.path===f.path?'selected':''}`}><button type="button" onClick={()=>chooseFile(f.path)}><FileCode2 size={14}/>{f.name}</button><EyeSource file={f.path} compact/></div>)}
                    {!files.length&&<div className="ws-empty">No accessible files were extracted.</div>}
                </>}
            </div>
        </div>
        <div className="ws-repo-right">
            {active?<>
                <div className="ws-repo-title"><div className="ws-repo-active"><FileCode2 size={16}/><strong title={active.path}>{active.path}</strong></div><EyeSource file={active.path}/></div>
                <div className="ws-repo-meta"><span>{active.language||'Language not identified'}</span><span>{funcs.length} detected functions</span><span>{classes.length} classes</span><span>{inbound.length} incoming · {outbound.length} outgoing dependencies</span></div>
                {typeof content==='string'?<div className="ws-repo-code" aria-label="Actual source preview">{content.split('\n').slice(0,16).map((line,i)=><div key={i}><span>{i+1}</span><code>{line||' '}</code></div>)}{content.split('\n').length>16&&<div className="ws-repo-truncated">Preview only · use the eye icon to inspect the complete read-only source</div>}</div>:<div className="ws-empty">Source text is missing or sensitive in this snapshot; no preview is shown.</div>}
                <div className="ws-repo-context"><strong>Detected symbols</strong><div className="ws-repo-symbols">{[...classes.map(c=>({name:c.name,line:c.line,type:'class'})),...funcs.map(f=>({name:f.name,line:f.line,type:'function'}))].slice(0,20).map((s,i)=><div key={i}><span>{s.type} · {s.name}</span><EyeSource file={active.path} line={s.line} compact/></div>)}{!classes.length&&!funcs.length&&<p className="ws-small">No supported symbols extracted for this file.</p>}</div></div>
                <div className="ws-repo-actions"><button type="button" className="ws-btn" onClick={()=>onNavigate('call-graph',{file:active.path})}>Call graph ↗</button><button type="button" className="ws-btn" onClick={()=>onNavigate('quality',{file:active.path})}>Code quality ↗</button><button type="button" className="ws-btn" onClick={()=>onNavigate('ai-preview',{file:active.path})}>AI Explorer ↗</button></div>
            </>:<div className="ws-empty">Select a file to inspect its actual contents, symbols and connections.</div>}
        </div>
    </div>;
}
