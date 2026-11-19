import { useMemo, useState } from 'react';

/** Bounded interactive SVG: only displays source-derived nodes/edges, never synthetic topology. */
export default function SourceDiagram({ nodes = [], edges = [], selected, onSelect, title='Relationship diagram' }) {
    const [limit, setLimit]=useState(24);
    const visible=nodes.slice(0,limit);
    const idSet=new Set(visible.map(n=>n.id));
    const displayEdges=edges.filter(e=>idSet.has(e.source)&&idSet.has(e.target)).slice(0,120);
    const points=useMemo(()=>{
        const n=visible.length,cols=Math.max(1,Math.ceil(Math.sqrt(n*1.7)));
        const positions=new Map();
        for(let i=0;i<n;i++) positions.set(visible[i].id,{x:100+(i%cols)*198,y:72+Math.floor(i/cols)*96});
        return {positions,cols,rows:Math.ceil(n/cols)};
    },[nodes,limit]);
    if(!nodes.length) return <div className="ws-empty">No supported relationships were extracted for this view. This is not proof that no relationships exist.</div>;
    const width=Math.max(360,points.cols*198+12),height=Math.max(172,points.rows*96+28);
    return <div className="ws-diagram" role="region" aria-label={title}>
        <div className="ws-diagram-scroll"><svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={title}>
            <defs><marker id="ws-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7b6aa5" /></marker></defs>
            {displayEdges.map((edge,i)=>{const a=points.positions.get(edge.source),b=points.positions.get(edge.target);if(!a||!b)return null;return <line key={`${edge.source}|${edge.target}|${i}`} x1={a.x} y1={a.y+20} x2={b.x} y2={b.y-20} stroke="#77628e" opacity=".6" strokeWidth="1.5" markerEnd="url(#ws-arrow)"/>})}
            {visible.map(node=>{const p=points.positions.get(node.id),isActive=selected===node.id;return <g key={node.id} role="button" tabIndex={0} aria-label={`Select ${node.label}`} onClick={()=>onSelect?.(node.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect?.(node.id);}}} style={{cursor:'pointer'}}><rect x={p.x-83} y={p.y-23} width="166" height="46" rx="9" fill={isActive?'#3f2b61':'#201b30'} stroke={isActive?'#c5a4ff':'#5e4d81'} strokeWidth={isActive?2.4:1.1}/><text x={p.x} y={p.y+4} fontSize="11" textAnchor="middle" fill="#eee2ff">{String(node.label||node.id).slice(0,24)}</text></g>})}
        </svg></div>
        <div className="ws-diagram-foot"><span>Showing {visible.length} / {nodes.length} nodes · {displayEdges.length} visible links</span>{visible.length<nodes.length&&<button className="ws-btn" onClick={()=>setLimit(v=>Math.min(nodes.length,v+24))}>Load 24 more</button>}</div>
        {visible.length<nodes.length&&<span className="ws-muted">The graph is bounded for readability; browse the lists for the full inventory.</span>}
    </div>;
}
