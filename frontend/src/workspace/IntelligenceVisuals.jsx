import { useMemo } from 'react';
import { BarChart3, Focus, ScanSearch } from 'lucide-react';
import { securityOverview, qualityOverview } from './intelligenceVisuals.js';
import { EyeSource } from './SourceViewer.jsx';

const palette={critical:'#fb768d',high:'#ec9b80',medium:'#e1b76a',low:'#66c9ac',info:'#799fd7',unrated:'#988aaa'};
const shortName=path=>String(path).split('/').pop();
function SeverityRing({levels,total}){
    if(!total)return <div className="ws-viz-empty"><ScanSearch size={26}/><span>No reported findings to chart</span></div>;
    let cursor=0;
    const stops=levels.map(({name,count})=>{
        const begin=cursor;cursor+=count/total*100;
        return `${palette[name]||palette.unrated} ${begin}% ${cursor}%`;
    }).join(',');
    return <div className="ws-severity-ring-wrap">
        <div className="ws-severity-ring" style={{background:`conic-gradient(${stops})`}} role="img" aria-label={`Scanner-reported severity distribution: ${levels.map(l=>`${l.name}: ${l.count}`).join(', ')}`}>
            <div className="ws-severity-ring-inner"><strong>{total}</strong><span>reported</span></div>
        </div>
        <div className="ws-severity-legend">{levels.map(({name,count})=><div className="ws-severity-legend-row" key={name}><i style={{background:palette[name]||palette.unrated}}/><span>{name}</span><strong>{count}</strong></div>)}</div>
    </div>;
}
export function SecurityVisuals({result,selectedIndex,onSelect}){
    const model=useMemo(()=>securityOverview(result),[result]);
    if(!model.available)return <div className="ws-empty">Security findings were not included in this snapshot; no distribution is inferred.</div>;
    return <div className="ws-intel-grid">
        <section className="ws-intel-card"><div className="ws-intel-title"><BarChart3 size={16}/><div><strong>Finding severity</strong><small>Actual scanner-reported categories</small></div></div>
            <SeverityRing levels={model.levels} total={model.total}/></section>
        <section className="ws-intel-card"><div className="ws-intel-title"><Focus size={16}/><div><strong>Source hotspots</strong><small>Files with the most reported findings</small></div></div>
            {model.files.length?<div className="ws-hotspot-list">{model.files.slice(0,12).map(({path,count,indexes})=><div className={`ws-hotspot-row ${indexes.includes(selectedIndex)?'is-selected':''}`} key={path}>
                <button type="button" title={path} onClick={()=>onSelect(indexes[0])}><span>{shortName(path)}</span><small>{path}</small></button>
                <span className="ws-hotspot-meter"><i style={{width:`${count/Math.max(1,model.files[0].count)*100}%`}}/></span>
                <strong>{count}</strong><EyeSource file={path} compact/>
            </div>)}</div>:<div className="ws-viz-empty">No findings with source file paths.</div>}
            {model.files.length>12&&<p className="ws-small">Showing the 12 most frequently reported source files out of {model.files.length}. Full inventory is below.</p>}
        </section>
    </div>;
}
export function QualityVisuals({result,selectedPath,onSelect}){
    const model=useMemo(()=>qualityOverview(result),[result]);
    if(!model.available)return <div className="ws-empty">File-level quality records were not included in this snapshot.</div>;
    return <div className="ws-intel-grid">
        <section className="ws-intel-card"><div className="ws-intel-title"><BarChart3 size={16}/><div><strong>Complexity heatmap</strong><small>Measured file scores · relative intensity</small></div></div>
            {model.measured.length?<div className="ws-complexity-grid">{model.measured.slice(0,48).map(({path,score})=>{
                const fraction=model.max>0?score/model.max:0;
                return <button type="button" key={path} className={`ws-complexity-tile ${path===selectedPath?'is-selected':''}`} title={`${path} · complexity estimate ${score}`} onClick={()=>onSelect(path)} style={{'--intensity':String(.16+fraction*.73)}}><strong>{shortName(path)}</strong><span>{score}</span></button>;
            })}</div>:<div className="ws-viz-empty">No numeric file complexity estimates available.</div>}
            <p className="ws-small">Color intensity is relative to the maximum measured score in this snapshot, not a risk or defect probability. {model.unmeasured} files have no numeric score.</p>
            {model.measured.length>48&&<p className="ws-small">Top 48 of {model.measured.length} measured files. Use the file inspector below to find the rest.</p>}
        </section>
        <section className="ws-intel-card"><div className="ws-intel-title"><Focus size={16}/><div><strong>Dependency coupling</strong><small>Distinct resolved file import relationships</small></div></div>
            {model.coupling.length?<div className="ws-coupling-list">{model.coupling.slice(0,12).map(item=><div className={`ws-coupling-row ${selectedPath===item.path?'is-selected':''}`} key={item.path}>
                <button type="button" title={item.path} onClick={()=>onSelect(item.path)}><strong>{shortName(item.path)}</strong><small>{item.path}</small></button>
                <div className="ws-coupling-bars"><div className="ws-coupling-track" title={`${item.importedBy} importing files`}><i style={{width:`${100*item.importedBy/Math.max(1,model.coupling[0].importedBy)}%`}}/></div><small>{item.importedBy} inbound</small></div>
                <EyeSource file={item.path} compact/>
            </div>)}</div>:<div className="ws-viz-empty">No resolved inter-file dependencies to chart.</div>}
            {model.coupling.length>12&&<p className="ws-small">Showing top 12 files ranked by incoming links. Complete source file list remains available below.</p>}
        </section>
    </div>;
}
