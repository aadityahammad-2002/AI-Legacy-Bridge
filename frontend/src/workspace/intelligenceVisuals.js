/** Pure presentation selectors over the active repository's Analysis Engine result. */
import { asArray, safePath, isConfirmed, riskLevel, findingLocation } from './workspaceData.js';

export const SEVERITY_ORDER=['critical','high','medium','low','info','unrated'];
export function securityOverview(result){
    if(!Array.isArray(result?.securityIssues))return {available:false,total:null,levels:[],files:[]};
    const findings=result.securityIssues;
    const levelCounts=new Map();const paths=new Map();
    findings.forEach((finding,index)=>{
        const level=riskLevel(finding)||'unrated';
        levelCounts.set(level,(levelCounts.get(level)||0)+1);
        const path=findingLocation(finding).path;
        if(!safePath(path))return;
        if(!paths.has(path))paths.set(path,{path,count:0,indexes:[],levels:new Map()});
        const entry=paths.get(path);entry.count++;entry.indexes.push(index);
        entry.levels.set(level,(entry.levels.get(level)||0)+1);
    });
    const levels=[...levelCounts.entries()].map(([name,count])=>({name,count}))
        .sort((a,b)=>{
            const ai=SEVERITY_ORDER.indexOf(a.name),bi=SEVERITY_ORDER.indexOf(b.name);
            return (ai<0?99:ai)-(bi<0?99:bi)||a.name.localeCompare(b.name);
        });
    const files=[...paths.values()].map(v=>({...v,levels:[...v.levels].map(([name,count])=>({name,count}))}))
        .sort((a,b)=>b.count-a.count||a.path.localeCompare(b.path));
    return {available:true,total:findings.length,levels,files};
}

export function qualityOverview(result){
    if(!Array.isArray(result?.files))return {available:false,measured:[],coupling:[],unmeasured:0,max:0};
    const files=result.files.filter(f=>safePath(f?.path));
    const measured=files.filter(f=>Number.isFinite(f?.complexity?.score))
        .map(f=>({path:f.path,score:f.complexity.score,loc:Number.isFinite(f.loc)?f.loc:null,level:f.complexity.level||null}))
        .sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
    const fileSet=new Set(files.map(f=>f.path));
    const outgoing=new Map(),incoming=new Map();
    for(const dep of asArray(result?.dependencies)){
        if(!isConfirmed(dep)||!fileSet.has(dep.source)||!fileSet.has(dep.target)||dep.source===dep.target)continue;
        if(!outgoing.has(dep.source))outgoing.set(dep.source,new Set());
        if(!incoming.has(dep.target))incoming.set(dep.target,new Set());
        outgoing.get(dep.source).add(dep.target);incoming.get(dep.target).add(dep.source);
    }
    const coupling=files.map(f=>({path:f.path,imports:outgoing.get(f.path)?.size||0,importedBy:incoming.get(f.path)?.size||0}))
        .filter(f=>f.imports||f.importedBy)
        .sort((a,b)=>b.importedBy-a.importedBy||b.imports-a.imports||a.path.localeCompare(b.path));
    return {available:true,measured,coupling,unmeasured:files.length-measured.length,max:Math.max(0,...measured.map(f=>f.score))};
}
