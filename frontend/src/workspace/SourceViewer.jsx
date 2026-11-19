import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, FileCode2, Maximize2, X } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { asArray, safePath, sensitivePath } from './workspaceData.js';

const SourceContext = createContext(null);
export const getSourceContent = (result,path) => {
    if (!safePath(path) || sensitivePath(path)) return null;
    const file = asArray(result?.files).find(f=>f.path===path);
    const content = typeof file?.content==='string' ? file.content
        : typeof result?.fileContents?.[path]==='string'?result.fileContents[path]:null;
    return content;
};
const extMap = {java:'java',py:'python',js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',sql:'sql',xml:'xml',yml:'yaml',yaml:'yaml',md:'markdown',css:'css',html:'html',go:'go',rb:'ruby',rs:'rust',kt:'kotlin',sh:'shell'};
export function SourceProvider({result,children,onSourceOpen}) {
    const [location,setLocation] = useState(null);
    const [expanded,setExpanded] = useState(false);
    const dialogRef = useRef(null);
    const priorFocusRef = useRef(null);
    const closeSource = () => {
        setLocation(null);
        setExpanded(false);
        const target = priorFocusRef.current;
        if(target?.isConnected) target.focus?.();
    };
    const sourceIndex=useMemo(()=>{
        const index=new Map();
        for(const file of asArray(result?.files))if(safePath(file?.path)&&typeof file.content==='string')index.set(file.path,file.content);
        if(result?.fileContents&&typeof result.fileContents==='object')for(const [path,content] of Object.entries(result.fileContents))if(safePath(path)&&typeof content==='string'&&!index.has(path))index.set(path,content);
        return index;
    },[result]);
    const openSource = (path,line=null) => {
        if(!safePath(path) || sensitivePath(path) || !sourceIndex.has(path)) return;
        priorFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null;
        const normalizedLine=Number(line);
        const targetLine=line==null||!Number.isSafeInteger(normalizedLine)||normalizedLine<=0?null:normalizedLine;
        setLocation({path,line:targetLine});
        onSourceOpen?.(path,targetLine);
    };
    useEffect(()=>{
        if(!location)return;
        const dialog=dialogRef.current;
        dialog?.querySelector('[aria-label="Close source view"]')?.focus();
        const handleKey=event=>{
            if(event.key==='Escape'){event.preventDefault();closeSource();return;}
            if(event.key!=='Tab'||!dialog)return;
            const elements=[...dialog.querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>el.getClientRects().length);
            if(!elements.length)return;
            const first=elements[0],last=elements[elements.length-1];
            if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
            else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
            else if(!dialog.contains(document.activeElement)){event.preventDefault();first.focus();}
        };
        window.addEventListener('keydown',handleKey);
        return()=>window.removeEventListener('keydown',handleKey);
    },[location]);
    const text=location?sourceIndex.get(location.path)??null:null;
    const language = location?extMap[location.path.split('.').pop()?.toLowerCase()]||'plaintext':'plaintext';
    const context = {openSource,available:(path)=>Boolean(safePath(path))&&!sensitivePath(path)&&sourceIndex.has(path)};
    return <SourceContext.Provider value={context}>{children}
        {location&&<div className="ws-source-overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)closeSource()}}><div ref={dialogRef} className={`ws-source-modal ${expanded?'is-expanded':''}`} role="dialog" aria-modal="true" aria-label={`Source code: ${location.path}`}>
            <div className="ws-source-modal-header"><FileCode2 size={17}/><div className="ws-source-modal-title"><strong>{location.path.split('/').pop()}</strong><small>{location.path}{location.line?` · Line ${location.line}`:''}</small></div><button className="ws-icon-btn" aria-label="Copy source path" title="Copy path" onClick={()=>navigator.clipboard?.writeText(location.path).catch(()=>{})}><Copy size={16}/></button><button className="ws-icon-btn" aria-label="Expand source view" onClick={()=>setExpanded(v=>!v)}><Maximize2 size={16}/></button><button className="ws-icon-btn" aria-label="Close source view" onClick={closeSource}><X size={17}/></button></div>
            {typeof text==='string' ? <Editor key={`${location.path}:${location.line??0}`} height="100%" path={location.path} language={language} value={text} theme="vs-dark" onMount={ed=>{if(location.line){
                const line=Math.min(location.line,ed.getModel()?.getLineCount()||location.line);
                ed.revealLineInCenter(line);ed.setPosition({lineNumber:line,column:1});
                ed.createDecorationsCollection?.([{range:{startLineNumber:line,startColumn:1,endLineNumber:line,endColumn:1},options:{isWholeLine:true,className:'ws-source-line-highlight',linesDecorationsClassName:'ws-source-gutter-highlight'}}]);
            }}} options={{readOnly:true,domReadOnly:true,minimap:{enabled:false},automaticLayout:true,lineNumbers:'on',scrollBeyondLastLine:false,wordWrap:'on',glyphMargin:false,renderLineHighlight:'line'}}/>:<div className="ws-empty">Source content is unavailable in this analysis snapshot. No code was fabricated.</div>}
        </div></div>}
    </SourceContext.Provider>;
}
export function EyeSource({file,line,label='View Source',compact=false}) {
    const source = useContext(SourceContext);
    if(!file)return null;
    const enabled=Boolean(source?.available(file));
    return <button type="button" className={compact?'ws-eye-icon':'ws-eye-btn'} disabled={!enabled} title={enabled?`View ${file}${line?`:${line}`:''}`:'Source not available or sensitive'} aria-label={`View Source ${file}`} onClick={e=>{e.stopPropagation();source?.openSource(file,line);}}><Eye size={compact?15:14}/>{!compact&&<span>{label}</span>}</button>;
}
export function SourceLocation({file,line}){
    if(!file)return <span className="ws-muted">Source location unavailable</span>;
    return <span className="ws-source-reference"><span className="ws-source"><FileCode2 size={13}/>{file}{line!=null?`:${line}`:''}</span><EyeSource file={file} line={line} compact/></span>;
}
