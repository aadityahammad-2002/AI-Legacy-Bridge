import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, Focus, Maximize2, Minus, MousePointer2, Plus, Search, X, Layers, Map as MapIcon, Crosshair } from 'lucide-react';
import { layoutEvidenceGraph, edgePath } from './graphLayout.js';
import { visibleEvidenceGraph, findGraphNode, edgeEvidenceLocation } from './graphViewportModel.js';
import { describeDiagramNode, diagramCategories, pointerFractions, zoomViewport, panViewport, nodeCenterViewport } from './diagramInteraction.js';
import { EyeSource } from './SourceViewer.jsx';

/** Evidence-only graph: richer presentation never manufactures relationship edges or source paths. */
const safeText = value => String(value ?? '');
const truncate = (value,length=30) => safeText(value).length>length?`${safeText(value).slice(0,length-1)}…`:safeText(value);
const NODE_WIDTH=202, NODE_HEIGHT=66;
export { layoutEvidenceGraph } from './graphLayout.js';

export default function InteractiveDiagram({nodes=[],edges=[],selected,onSelect,title='Interactive relationships',maxInitial=80}){
    const [limit,setLimit]=useState(maxInitial);
    const [query,setQuery]=useState('');
    const [direction,setDirection]=useState('LR');
    const [focusOnly,setFocusOnly]=useState(false);
    const [viewport,setViewport]=useState(null);
    const [full,setFull]=useState(false);
    const [mapOpen,setMapOpen]=useState(false);
    const [highlightKind,setHighlightKind]=useState(null);
    const [internalSelected,setInternalSelected]=useState(null);
    const [inspectedLink,setInspectedLink]=useState(null);
    const [searchError,setSearchError]=useState('');
    const selectedId=selected===undefined?internalSelected:selected;
    const selectNode=useCallback(id=>{if(onSelect)onSelect(id);else setInternalSelected(id);setInspectedLink(null);},[onSelect]);
    const svgRef=useRef(null),pointer=useRef(null),focusRequested=useRef(null);
    const markerId=useId().replace(/:/g,'');
    const graphWindow=useMemo(()=>visibleEvidenceGraph(nodes,edges,{nodeLimit:limit,selected:selectedId,neighborsOnly:focusOnly,edgeLimit:1200}),[nodes,edges,limit,selectedId,focusOnly]);
    const visibleNodes=graphWindow.nodes, visibleEdges=graphWindow.edges;
    const layout=useMemo(()=>layoutEvidenceGraph(visibleNodes,visibleEdges,direction),[visibleNodes,visibleEdges,direction]);
    const fit=useCallback(()=>({x:0,y:0,w:layout.width,h:layout.height}),[layout.width,layout.height]);
    const view=viewport||fit();
    const currentNode=visibleNodes.find(n=>n.id===selectedId)||null;
    const selectedDetail=currentNode?describeDiagramNode(currentNode):null;
    const categories=useMemo(()=>diagramCategories(visibleNodes),[visibleNodes]);
    const presentationById=useMemo(()=>new Map(visibleNodes.map(n=>[n.id,describeDiagramNode(n)])),[visibleNodes]);
    const selectedLinks=selectedId==null?[]:visibleEdges.filter(e=>e.source===selectedId||e.target===selectedId);
    const highlighted=new Set(selectedLinks.flatMap(e=>[e.source,e.target]));if(selectedId!=null)highlighted.add(selectedId);
    const inspected=inspectedLink&&visibleEdges.includes(inspectedLink)?inspectedLink:null;
    const evidence=edgeEvidenceLocation(inspected);

    // Only structural changes reset the canvas. Clicking a node must NOT reset pan/zoom.
    useEffect(()=>{setViewport(null);setInspectedLink(null);},[nodes,edges,direction,limit,focusOnly]);
    useEffect(()=>{
        if(focusRequested.current==null)return;
        const p=layout.positions.get(focusRequested.current);
        if(p){setViewport(old=>nodeCenterViewport(p,layout,old));focusRequested.current=null;}
    },[layout]);
    useEffect(()=>{
        if(!full)return;
        const onKey=e=>{if(e.key==='Escape')setFull(false)};
        window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
    },[full]);
    const zoom=useCallback(factor=>setViewport(old=>zoomViewport(old||fit(),{x:.5,y:.5},factor,layout.width*.09,layout.width*5)),[fit,layout.width]);
    const wheel=useCallback(event=>{
        event.preventDefault();
        const rect=svgRef.current?.getBoundingClientRect();if(!rect?.width||!rect?.height)return;
        setViewport(old=>{
            const prev=old||fit();
            return zoomViewport(prev,pointerFractions(prev,rect,event.clientX,event.clientY),event.deltaY>0?1.12:.89,layout.width*.09,layout.width*5);
        });
    },[fit,layout.width]);
    useEffect(()=>{const svg=svgRef.current;if(!svg)return;svg.addEventListener('wheel',wheel,{passive:false});return()=>svg.removeEventListener('wheel',wheel);},[wheel,visibleNodes.length]);
    const startPan=event=>{
        if(event.button!==0||event.target.closest?.('[data-node], [data-relation]'))return;
        pointer.current={x:event.clientX,y:event.clientY,start:viewport||fit()};
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };
    const pan=event=>{
        const p=pointer.current;if(!p)return;
        const rect=svgRef.current?.getBoundingClientRect();if(!rect?.width||!rect?.height)return;
        setViewport(panViewport(p.start,rect,event.clientX-p.x,event.clientY-p.y));
    };
    const centerSelected=()=>{
        if(!selectedId)return;
        const p=layout.positions.get(selectedId);
        if(p)setViewport(old=>nodeCenterViewport(p,layout,old));
        else focusRequested.current=selectedId;
    };
    const chooseSearch=()=>{
        const term=query.trim();if(!term)return;
        const match=findGraphNode(nodes,term);
        if(!match){setSearchError('No matching node in this graph');return;}
        setSearchError('');setFocusOnly(false);
        const relayoutLikely=selected!==undefined && (selected!==match.id||focusOnly);
        if(relayoutLikely)focusRequested.current=match.id;
        selectNode(match.id);
        if(!relayoutLikely){
            const p=layout.positions.get(match.id);
            if(p)setViewport(old=>nodeCenterViewport(p,layout,old));
            else focusRequested.current=match.id;
        }
    };
    const openRelationship=e=>{setInspectedLink(e);};
    if(!nodes.length)return <div className="ws-empty">No relationship nodes were extracted for this view. Check analysis coverage; an empty graph does not prove there are no relationships.</div>;
    return <div className={`ws-interactive ${full?'is-fullscreen':''}`} aria-label={title}>
        <div className="ws-graph-toolbar">
            <div className="ws-graph-title"><MousePointer2 size={15}/><strong>{title}</strong><span>{visibleNodes.length} nodes · {visibleEdges.length} links</span><span title="Counts computed from displayed source-backed relationships"><Layers size={12}/>{layout.components} groups · {layout.cyclicGroups} cycles</span></div>
            <div className="ws-graph-actions">
                <label className="ws-graph-search"><Search size={13}/><input aria-label="Find graph node" placeholder="Find node…" value={query} onChange={event=>{setQuery(event.target.value);setSearchError('');}} onKeyDown={event=>{if(event.key==='Enter')chooseSearch();}}/><button type="button" onClick={chooseSearch} aria-label="Focus matching node">Go</button></label>
                <span className="ws-graph-search-status" role="status">{searchError}</span>
                <button className="ws-icon-btn" title="Change diagram direction" aria-label="Change graph direction" onClick={()=>setDirection(v=>v==='LR'?'TB':'LR')}><ArrowDownUp size={16}/></button>
                <button className="ws-icon-btn" title="Zoom in" aria-label="Zoom in" onClick={()=>zoom(.77)}><Plus size={16}/></button>
                <button className="ws-icon-btn" title="Zoom out" aria-label="Zoom out" onClick={()=>zoom(1.3)}><Minus size={16}/></button>
                <button className="ws-icon-btn" title="Fit graph" aria-label="Fit graph" onClick={()=>setViewport(fit())}><Focus size={16}/></button>
                <button className="ws-icon-btn" title="Center selected node" aria-label="Center selected node" disabled={!selectedId} onClick={centerSelected}><Crosshair size={16}/></button>
                <button className={`ws-icon-btn ${mapOpen?'is-on':''}`} title="Toggle graph overview" aria-label="Toggle graph overview" aria-pressed={mapOpen} onClick={()=>setMapOpen(v=>!v)}><MapIcon size={16}/></button>
                <button className="ws-icon-btn" title={full?'Close fullscreen':'Fullscreen diagram'} aria-label={full?'Close fullscreen':'Fullscreen graph'} onClick={()=>setFull(v=>!v)}>{full?<X size={16}/>:<Maximize2 size={16}/>}</button>
            </div>
        </div>
        <div className="ws-diagram-legend" aria-label="Node categories — highlight without filtering evidence">
            {categories.map(c=><button key={c.key} className={`ws-diagram-category ${highlightKind===c.key?'is-on':''}`} style={{'--category-color':c.color}} aria-pressed={highlightKind===c.key} onClick={()=>setHighlightKind(highlightKind===c.key?null:c.key)}><span className="ws-diagram-swatch"/>{c.label} <b>{c.count}</b></button>)}
            {highlightKind&&<button className="ws-diagram-clear" onClick={()=>setHighlightKind(null)}>Show all</button>}
        </div>
        <div className="ws-graph-stage">
            <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={title} onPointerDown={startPan} onPointerMove={pan} onPointerUp={()=>{pointer.current=null;}} onPointerCancel={()=>{pointer.current=null;}}>
                <defs><pattern id={`${markerId}-dots`} width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1.2" fill="#775d9d" opacity=".28"/></pattern><marker id={`${markerId}-arrow`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#a492c1"/></marker></defs>
                <rect x={view.x} y={view.y} width={view.w} height={view.h} fill={`url(#${markerId}-dots)`} pointerEvents="none"/>
                {visibleEdges.map((edge,i)=>{
                    const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);if(!a||!b)return null;
                    const active=inspected===edge||(selectedId!=null&&(edge.source===selectedId||edge.target===selectedId));
                    const fade=selectedId!=null&&!active;
                    const catFade=highlightKind&&![edge.source,edge.target].some(id=>presentationById.get(id)?.key===highlightKind);
                    const path=edgePath(a,b,direction);
                    return <g key={`${edge.source}:${edge.target}:${i}`}>
                        <path d={path} fill="none" stroke={active?'#d0b4ff':'#8d76b4'} strokeWidth={active?3:1.8} opacity={fade || catFade ? .17 : .85} markerEnd={`url(#${markerId}-arrow)`} pointerEvents="none" aria-hidden="true"/>
                        <path d={path} fill="none" stroke="transparent" strokeWidth="18" pointerEvents="stroke" data-relation="true" tabIndex={-1} aria-label={`Inspect relationship ${safeText(edge.source)} to ${safeText(edge.target)}`} onClick={event=>{event.stopPropagation();openRelationship(edge);}} style={{cursor:'pointer'}}><title>{`${safeText(edge.source)} → ${safeText(edge.target)}${edge.column?` · FK ${edge.column}`:''}`}</title></path>
                    </g>;
                })}
                {visibleNodes.map(node=>{
                    const p=layout.positions.get(node.id);if(!p)return null;
                    const d=presentationById.get(node.id)||describeDiagramNode(node);
                    const active=selectedId===node.id;
                    const dim=(selectedId!=null&&!highlighted.has(node.id))||(highlightKind!=null&&d.key!==highlightKind);
                    return <g key={String(node.id)} data-node="true" tabIndex={0} role="button" aria-label={`Select ${safeText(node.label)} (${d.kind})`} aria-pressed={active} onClick={()=>selectNode(node.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectNode(node.id);}}} style={{cursor:'pointer',opacity:dim ? .32 : 1}}>
                        <rect x={p.x} y={p.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="12" fill={active?'#382b50':d.fill} stroke={active?'#f0d8ff':d.accent} strokeWidth={active?2.7:1.35}/>
                        <rect x={p.x+10} y={p.y+11} width="5" height="44" rx="2.5" fill={d.accent}/>
                        <text x={p.x+24} y={p.y+18} fontSize="8" fontWeight="720" letterSpacing=".65" fill={d.accent}>{d.kind.toUpperCase()}</text>
                        <text x={p.x+24} y={p.y+37} fontSize="12.5" fontWeight="660" fill="#f4eafe"><title>{safeText(node.label)}</title>{truncate(node.label,26)}</text>
                        <text x={p.x+24} y={p.y+54} fontSize="10" fill="#b9aecb">{truncate(d.subtitle,31)}</text>
                        {p.cycleSize>1&&<circle cx={p.x+189} cy={p.y+14} r="4" fill="#efbb82"><title>Part of a cycle of {p.cycleSize} nodes</title></circle>}
                    </g>;
                })}
            </svg>
            {mapOpen&&<div className="ws-mini-map" aria-label="Diagram overview map"><div className="ws-mini-map-title">Diagram overview <button onClick={()=>setMapOpen(false)} aria-label="Close diagram overview"><X size={12}/></button></div><svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();const xy=pointerFractions({x:0,y:0,w:layout.width,h:layout.height},rect,event.clientX,event.clientY);setViewport(old=>{const v=old||fit();return {...v,x:xy.x*layout.width-v.w/2,y:xy.y*layout.height-v.h/2};});}}>{visibleEdges.slice(0,500).map((edge,i)=>{const a=layout.positions.get(edge.source),b=layout.positions.get(edge.target);return a&&b?<path key={i} d={`M${a.x+101},${a.y+33}L${b.x+101},${b.y+33}`} stroke="#5f507d" strokeWidth="5" fill="none"/>:null;})}{visibleNodes.map(n=>{const p=layout.positions.get(n.id);return p?<rect key={n.id} x={p.x} y={p.y} width="202" height="66" rx="10" fill={describeDiagramNode(n).accent} opacity={n.id===selectedId?1:.75}/>:null;})}<rect x={view.x} y={view.y} width={view.w} height={view.h} stroke="#f4e8ff" strokeWidth="7" fill="#ddd4ff" fillOpacity=".08" pointerEvents="none"/></svg></div>}
            <div className="ws-graph-hint">Drag to pan · Scroll to zoom · Click node or link · Search to focus</div>
        </div>
        {currentNode&&<div className="ws-diagram-selection" role="region" aria-label="Selected graph node details"><div className="ws-diagram-selection-info"><span>{selectedDetail.kind}</span><strong>{currentNode.label}</strong><small>{selectedDetail.subtitle}</small></div>{selectedDetail.file&&<EyeSource file={selectedDetail.file} line={selectedDetail.line} compact/>}{Array.isArray(currentNode.files)&&currentNode.files.slice(0,3).map(path=><EyeSource key={path} file={path} compact/>)}<button className="ws-btn" onClick={centerSelected}><Crosshair size={13}/> Center</button></div>}
        {selectedLinks.length>0&&<div className="ws-diagram-relations"><div className="ws-diagram-relations-head"><strong>Connected relationships</strong><span>{selectedLinks.length} displayed · click for evidence</span></div><div className="ws-diagram-relation-list">{selectedLinks.slice(0,16).map((link,i)=><button key={`${link.source}:${link.target}:${i}`} onClick={()=>openRelationship(link)} className={inspected===link?'is-on':''}><span>{truncate(link.source,32)} → {truncate(link.target,32)}</span><small>{link.kind||link.type||link.column||'Source connection'}</small></button>)}{selectedLinks.length>16&&<small>Showing 16 of {selectedLinks.length} displayed relationships. Use search to narrow the graph.</small>}</div></div>}
        {inspected&&<div className="ws-graph-inspector" role="region" aria-label="Selected source relationship"><div className="ws-graph-inspector-detail"><strong>Selected relationship</strong><span title={`${safeText(inspected.source)} → ${safeText(inspected.target)}`}>{truncate(inspected.source,55)} → {truncate(inspected.target,55)}</span><small>{[inspected.kind||inspected.type,Number.isFinite(inspected.count)?`${inspected.count} source references`:null,inspected.confidence?`Confidence: ${inspected.confidence}`:null,inspected.column?`Foreign key: ${inspected.column}`:null,inspected.channel?`Channel: ${inspected.channel}`:null,inspected.resolution?`Resolution: ${inspected.resolution}`:null].filter(Boolean).join(' · ')||'Source-derived graph relationship'}</small></div>{evidence&&<EyeSource file={evidence.file} line={evidence.line} compact/>}<button type="button" className="ws-icon-btn" onClick={()=>setInspectedLink(null)} aria-label="Close relationship details"><X size={15}/></button></div>}
        <div className="ws-graph-footer"><span>{visibleNodes.length} / {nodes.length} source-derived nodes · {visibleEdges.length} / {graphWindow.eligibleEdges} displayed eligible links</span><div className="ws-graph-actions"><label className="ws-check"><input type="checkbox" checked={focusOnly} disabled={selectedId==null} onChange={e=>setFocusOnly(e.target.checked)}/> Only neighbors</label>{nodes.length>limit&&<button className="ws-btn" onClick={()=>setLimit(v=>Math.min(nodes.length,v+80))}>Show 80 more</button>}</div></div>
        {(graphWindow.omittedNodes>0||graphWindow.omittedEdges>0||graphWindow.duplicateNodeIds>0)&&<p className="ws-small" role="status">Progressive view: {graphWindow.omittedNodes>0?`${graphWindow.omittedNodes} additional nodes in this view. `:''}{graphWindow.omittedEdges>0?`${graphWindow.omittedEdges} eligible links hidden by the rendering budget. `:''}{graphWindow.selectedIncidentEligible>graphWindow.selectedIncidentRendered?`${graphWindow.selectedIncidentEligible-graphWindow.selectedIncidentRendered} selected-node links exceed the rendering cap. `:''}{graphWindow.duplicateNodeIds>0?`${graphWindow.duplicateNodeIds} duplicate node IDs deduplicated in the view. `:''}No source graph records are deleted by this visualization.</p>}
    </div>;
}
