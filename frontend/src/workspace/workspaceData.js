/** Read-only projections of the frozen Analysis Engine result. Never invent missing records. */
export const asArray = value => Array.isArray(value) ? value : [];
export const textValue = value => (value == null ? '' : String(value));
export const hasList = value => Array.isArray(value);
export const countOrUnknown = value => Array.isArray(value) ? value.length : null;
export const safePath = value => {
    const path = textValue(value).replace(/\\/g, '/');
    return path && !path.startsWith('/') && !path.split('/').includes('..') && !/^[a-z]:\//i.test(path) ? path : null;
};
export const sensitivePath = path => /(^|\/)(\.env(?:\.|$)|secrets?\/|credentials?\/|id_rsa|.*\.(?:pem|p12|key)$)/i.test(textValue(path));
export const isConfirmed = edge => edge?.resolution === 'resolved' || edge?.resolution === 'static-resolved';

export const fileGroup = path => {
    const parts = textValue(path).split('/').filter(Boolean);
    // Conventional monorepo service roots are evidence from the directory names,
    // not proof of independently deployed microservices.
    if (/^(services|apps|packages)$/i.test(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
    const src = parts.indexOf('src');
    if (src !== -1) {
        const packageParts = parts.slice(src + 1, -1);
        while (['main','test','java','kotlin','scala','python','js','ts'].includes(packageParts[0])) packageParts.shift();
        if (['com','org','net','io','dev'].includes(packageParts[0]) && packageParts.length > 2) packageParts.splice(0,2);
        if (packageParts[0]) return packageParts[0];
    }
    return parts.length > 1 ? parts[0] : 'root';
};

export function makeArchitecture(result) {
    const files = asArray(result?.files);
    const deps = asArray(result?.dependencies);
    const modules = new Map();
    for (const file of files) {
        if (!safePath(file?.path)) continue;
        const key = fileGroup(file.path);
        if (!modules.has(key)) modules.set(key, { id:key, label:key, files:[], layerCounts:{} });
        const entry = modules.get(key);
        entry.files.push(file.path);
        const layer = file.layer || 'unclassified';
        entry.layerCounts[layer] = (entry.layerCounts[layer] || 0) + 1;
    }
    const existing = new Map(files.map(file => [file.path, fileGroup(file.path)]));
    const edges = new Map();
    for (const dep of deps) {
        if (!isConfirmed(dep)) continue;
        const a=existing.get(dep.source), b=existing.get(dep.target);
        if (!a || !b || a===b) continue;
        const id=JSON.stringify([a,b]);
        if (!edges.has(id)) edges.set(id,{ source:a,target:b,count:0,evidence:[] });
        const item=edges.get(id);item.count++;
        if(item.evidence.length<5)item.evidence.push({ source:dep.source,target:dep.target,line:dep.line??null,type:dep.type||'dependency' });
    }
    return { nodes:[...modules.values()].sort((a,b)=>a.id.localeCompare(b.id)), edges:[...edges.values()] };
}

export function makeLayerGraph(result) {
    const files=asArray(result?.files), dependencies=asArray(result?.dependencies);
    const layers=new Map();
    const paths=new Map();
    for(const f of files){
        if(!safePath(f?.path))continue;
        const group=String(f.layer||'unclassified');
        paths.set(f.path,group);
        if(!layers.has(group))layers.set(group,{id:group,label:group,fileCount:0});
        layers.get(group).fileCount++;
    }
    const links=new Map();
    for(const dep of dependencies){
        if(!isConfirmed(dep))continue;
        const a=paths.get(dep.source),b=paths.get(dep.target);
        if(!a||!b||a===b)continue;
        const key=JSON.stringify([a,b]);
        if(!links.has(key))links.set(key,{source:a,target:b,count:0});
        links.get(key).count++;
    }
    return {nodes:[...layers.values()],edges:[...links.values()]};
}

export function makeMessageGraph(result) {
    const links=asArray(result?.crossSystemIntelligence?.messageLinks);
    const nodes=new Map();const edges=[];
    for(const item of links){
        const a=item?.source?.file,b=item?.target?.file;
        if(!safePath(a)||!safePath(b))continue;
        if(!nodes.has(a))nodes.set(a,{id:a,label:a.split('/').pop(),file:a});
        if(!nodes.has(b))nodes.set(b,{id:b,label:b.split('/').pop(),file:b});
        edges.push({source:a,target:b,channel:item.channel,confidence:item.confidence,resolution:item.resolution,file:a,line:item?.source?.line??null});
    }
    return {nodes:[...nodes.values()],edges};
}

export function makeDatabase(result) {
    const db=result?.databaseSchema;
    const tables=asArray(db?.tables).filter(t=>t&&textValue(t.name));
    const nodes=tables.map((t,i)=>({id:`table:${i}`,label:textValue(t.name),table:t,index:i}));
    const byName=new Map();
    for(const node of nodes){const name=node.label.toLowerCase();if(!byName.has(name))byName.set(name,[]);byName.get(name).push(node);}
    const edges=[];
    for(const node of nodes){for(const fk of asArray(node.table.foreignKeys)){
        const candidates=byName.get(textValue(fk.referencesTable).toLowerCase())||[];
        if(candidates.length===1)edges.push({source:node.id,target:candidates[0].id,column:fk.column||null,table:node.label,file:node.table.file||null});
    }}
    return {nodes,edges,ambiguousNames:[...byName.entries()].filter(([,rows])=>rows.length>1).map(([name])=>name)};
}

export function makeCallGraph(result){
    const all=asArray(result?.callGraph?.functionConnections);
    const good=all.filter(edge=>isConfirmed(edge)&&edge?.callerFunctionKey&&edge?.calleeFunctionKey);
    const nodes=new Map();const edges=[];
    for(const item of good){
        const caller={ id:item.callerFunctionKey,label:item.callerFunctionName||item.callerFunctionKey,file:item.callerFile,line:item.callerStartLine };
        const callee={ id:item.calleeFunctionKey,label:item.calleeFunctionName||item.calleeFunctionKey,file:item.calleeFile,line:item.calleeStartLine };
        nodes.set(caller.id,caller);nodes.set(callee.id,callee);
        edges.push({ source:caller.id,target:callee.id,site:item.callSiteLine,caller:item.callerFile,callee:item.calleeFile });
    }
    return {nodes:[...nodes.values()],edges,rawCount:all.length,unresolved:result?.callGraph?.diagnostics?.unresolvedCallCount??null,ambiguous:result?.callGraph?.diagnostics?.ambiguousCallCount??null};
}

export function makeApiGraph(result,endpoint) {
    if(!endpoint?.file) return {nodes:[],edges:[]};
    const files = new Set(asArray(result?.files).map(f=>f.path));
    const deps = asArray(result?.dependencies).filter(d=>isConfirmed(d)&&d.source===endpoint.file&&files.has(d.target));
    const routeId=`endpoint:${endpoint.method||''}:${endpoint.path||''}:${endpoint.file}:${endpoint.line??''}`;
    const nodes=[{id:routeId,label:`${endpoint.method||'ROUTE'} ${endpoint.path||''}`,kind:'endpoint',file:endpoint.file,line:endpoint.line??null},{id:endpoint.file,label:endpoint.file.split('/').pop(),kind:'source',file:endpoint.file}];
    const edges=[{source:routeId,target:endpoint.file,kind:'declared-in',file:endpoint.file,line:endpoint.line??null}];
    const seen=new Set([endpoint.file]);
    for(const edge of deps){if(!seen.has(edge.target)){seen.add(edge.target);nodes.push({id:edge.target,label:edge.target.split('/').pop(),file:edge.target,kind:'dependency'});}edges.push({source:endpoint.file,target:edge.target,kind:edge.type||'dependency',file:endpoint.file,line:edge.line??null});}
    return {nodes,edges};
}

export function riskLevel(finding){return textValue(finding?.severity||finding?.level||finding?.priority||'unrated').toLowerCase();}
export function findingLocation(finding){return {path:finding?.file||finding?.path||finding?.location?.path||null,line:finding?.line??finding?.location?.startLine??null};}
export const analysisPresent=(result,key)=>Boolean(result&&Object.prototype.hasOwnProperty.call(result,key));

export function moduleSummary(result){
    const files=asArray(result?.files),endpoints=asArray(result?.apiEndpoints),tables=asArray(result?.databaseSchema?.tables),deps=asArray(result?.dependencies);
    const resultFiles=files.length;
    const langs=new Map();for(const f of files){if(!f.language||f.language==='other')continue;langs.set(f.language,(langs.get(f.language)||0)+1);}
    return {files:analysisPresent(result,'files')?resultFiles:null,functions:countOrUnknown(result?.functions),classes:countOrUnknown(result?.classes),endpoints:countOrUnknown(result?.apiEndpoints),tables:countOrUnknown(result?.databaseSchema?.tables),security:countOrUnknown(result?.securityIssues),dependencies:countOrUnknown(result?.dependencies),findings:countOrUnknown(result?.findings),languages:[...langs.entries()].sort((a,b)=>b[1]-a[1]), health:Number.isFinite(result?.healthScore?.score)?result.healthScore.score:null,grade:result?.healthScore?.grade||null,coverage:result?.analysisCoverage?.status||null, resolvedDependencies:deps.filter(isConfirmed).length};
}

/** Evidence based logical application tiers. A tier node is not a runtime service. */
export function makeTierArchitecture(result) {
    const files=asArray(result?.files).filter(f=>safePath(f.path));
    const detect=f=>{
        const path=f.path.toLowerCase();
        if (/(^|\/)(frontend|client|web|ui)(\/|$)/.test(path)) return 'Presentation';
        if (/(^|\/)(ai-service|ml-service|inference)(\/|$)/.test(path)) return 'AI / Inference';
        if (/\.(sql)$/.test(path) || /(^|\/)(migrations?|db|database)(\/|$)/.test(path)) return 'Data definitions';
        if (/(^|\/)(backend|server|api)(\/|$)/.test(path)) return 'Application / API';
        const layer=String(f.layer||'').toLowerCase();
        if (['controller','presentation','view','component','ui'].includes(layer))return 'Presentation';
        if (['service','feature','router','api'].includes(layer))return 'Application / API';
        if (['repository','dao','entity','model','data'].includes(layer))return 'Data definitions';
        return 'Unclassified';
    };
    const groups=new Map(),pathToTier=new Map();
    for (const file of files){const label=detect(file);pathToTier.set(file.path,label);if(!groups.has(label))groups.set(label,{id:label,label,files:[],kind:'tier'});groups.get(label).files.push(file.path);}
    const links=new Map();
    for (const edge of asArray(result?.dependencies)) {
        if(!isConfirmed(edge))continue;
        const source=pathToTier.get(edge.source),target=pathToTier.get(edge.target);
        if(!source||!target||source===target)continue;
        const key=JSON.stringify([source,target]);
        if(!links.has(key))links.set(key,{source,target,count:0,evidence:[],kind:'resolved-import'});
        const value=links.get(key);value.count++;
        if(value.evidence.length<5)value.evidence.push({file:edge.source,line:edge.line,target:edge.target});
    }
    return {nodes:[...groups.values()],edges:[...links.values()],classifiedTierCount:[...groups.keys()].filter(x=>x!=='Unclassified').length,semantics:'Path/layer classification only. Edges require resolved source dependencies, not assumed runtime network traffic.'};
}

/** A conventional service-root directory is a candidate, not proof of independently deployed microservices. */
export function makeServiceCandidates(result){
    const groups=new Map(),byPath=new Map();
    for (const file of asArray(result?.files)) {
        if(!safePath(file?.path))continue;
        const path=file.path.replace(/\\/g,'/');
        const match=path.match(/(?:^|\/)(services|apps)\/([^/]+)\//i);
        if(!match)continue;
        const service=`${match[1]}/${match[2]}`;
        if(!groups.has(service))groups.set(service,{id:service,label:match[2],kind:'service-candidate',files:[],candidateReason:'Conventional services/apps directory; deployment status not proven'});
        groups.get(service).files.push(path);byPath.set(path,service);
    }
    const links=new Map();
    for (const dep of asArray(result?.dependencies)){
        if(!isConfirmed(dep))continue;
        const a=byPath.get(dep.source),b=byPath.get(dep.target);if(!a||!b||a===b)continue;
        const id=JSON.stringify([a,b]);if(!links.has(id))links.set(id,{source:a,target:b,count:0,kind:'code-dependency',evidence:[]});
        const entry=links.get(id);entry.count++;
        if(entry.evidence.length<4)entry.evidence.push({file:dep.source,line:dep.line,target:dep.target});
    }
    return {nodes:[...groups.values()],edges:[...links.values()],semantics:'Candidate service boundaries derived from repository directories; code-level imports do not prove runtime HTTP/messaging communication.'};
}
