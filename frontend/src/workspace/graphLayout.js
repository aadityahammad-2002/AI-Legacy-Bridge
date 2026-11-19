/**
 * Source-evidence graph layout for the workspace. No inferred nodes or edges.
 * Weakly-connected components are packed separately; strongly-connected cycles
 * are condensed before topological ranking. Pure/deterministic and dependency free.
 */
const NODE_WIDTH = 202;
const NODE_HEIGHT = 66;
const nodeComparator = (a, b) => String(a).localeCompare(String(b));
const keyOf = node => String(node?.id ?? '');

function connectedComponents(ids, undirected) {
    const visited = new Set();
    const groups = [];
    for (const id of ids) {
        if (visited.has(id)) continue;
        const todo = [id], group = [];
        visited.add(id);
        for (let i = 0; i < todo.length; i++) {
            const current = todo[i];
            group.push(current);
            for (const other of undirected.get(current) || []) {
                if (!visited.has(other)) {visited.add(other);todo.push(other);}
            }
        }
        groups.push(group.sort(nodeComparator));
    }
    return groups.sort((a,b)=>b.length-a.length||nodeComparator(a[0],b[0]));
}

function stronglyConnected(ids, forward, reverse) {
    // Iterative Kosaraju prevents stack overflow on large dependency chains.
    const visited = new Set(), finishing = [];
    for (const id of ids) {
        if (visited.has(id)) continue;
        visited.add(id);
        const stack = [{id, index:0}];
        while (stack.length) {
            const cur = stack[stack.length-1], nexts = forward.get(cur.id) || [];
            if (cur.index >= nexts.length) {finishing.push(cur.id);stack.pop();continue;}
            const next = nexts[cur.index++];
            if (!visited.has(next)) {visited.add(next);stack.push({id:next,index:0});}
        }
    }
    visited.clear();
    const components=[];
    for (let i=finishing.length-1;i>=0;i--) {
        const id=finishing[i];if(visited.has(id))continue;
        const component=[],queue=[id];visited.add(id);
        for(let k=0;k<queue.length;k++){
            const node=queue[k];component.push(node);
            for(const previous of reverse.get(node)||[]){if(!visited.has(previous)){visited.add(previous);queue.push(previous);}}
        }
        components.push(component.sort(nodeComparator));
    }
    return components;
}

function layoutComponent(ids, forward, reverse, direction) {
    const idSet=new Set(ids);
    const f=new Map(ids.map(id=>[id,(forward.get(id)||[]).filter(n=>idSet.has(n))]));
    const r=new Map(ids.map(id=>[id,(reverse.get(id)||[]).filter(n=>idSet.has(n))]));
    const sccs=stronglyConnected(ids,f,r);
    const membership=new Map();
    sccs.forEach((members,i)=>members.forEach(id=>membership.set(id,i)));
    const next=new Map(sccs.map((_,i)=>[i,new Set()]));
    const prev=new Map(sccs.map((_,i)=>[i,new Set()]));
    const indegree=sccs.map(()=>0);
    for(const id of ids) for(const to of f.get(id)) {
        const a=membership.get(id),b=membership.get(to);if(a===b||next.get(a).has(b))continue;
        next.get(a).add(b);prev.get(b).add(a);indegree[b]++;
    }
    const sortedComponents=(a,b)=>nodeComparator(sccs[a][0],sccs[b][0]);
    const ready=sccs.map((_,i)=>i).filter(i=>indegree[i]===0).sort(sortedComponents);
    const rank=new Array(sccs.length).fill(0);
    const order=[];
    while(ready.length){
        const current=ready.shift();order.push(current);
        for(const target of [...next.get(current)].sort(sortedComponents)){
            rank[target]=Math.max(rank[target],rank[current]+1);
            indegree[target]--;
            if(indegree[target]===0){ready.push(target);ready.sort(sortedComponents);}
        }
    }
    const layers=new Map();
    for(const idx of order){const k=rank[idx];if(!layers.has(k))layers.set(k,[]);layers.get(k).push(idx);}
    // Barycentric sweeps reduce crossings for branched graphs; preserve stable ties.
    const keys=[...layers.keys()].sort((a,b)=>a-b);
    const pos=new Map();
    const sortLayer=(level, neighbors)=>{
        const row=layers.get(level);
        const center=id=>{
            const refs=[...neighbors.get(id)].filter(x=>pos.has(x));
            if(!refs.length)return null;
            return refs.reduce((a,b)=>a+pos.get(b),0)/refs.length;
        };
        row.sort((a,b)=>{
            const ac=center(a),bc=center(b);
            if(ac===null&&bc===null)return sortedComponents(a,b);
            if(ac===null)return 1;if(bc===null)return -1;
            return ac-bc||sortedComponents(a,b);
        });
        row.forEach((id,i)=>pos.set(id,i));
    };
    for(let pass=0;pass<3;pass++){
        for(const k of keys){if(pass===0&&k===keys[0])layers.get(k).forEach((id,i)=>pos.set(id,i));else sortLayer(k,prev);}
        for(const k of [...keys].reverse())sortLayer(k,next);
    }
    const points=new Map();
    const mainGap=direction==='LR'?282:140;
    const crossGap=direction==='LR'?105:255;
    for(const level of keys){
        const row=layers.get(level);
        const count=row.reduce((sum,i)=>sum+sccs[i].length,0);
        let cursor=0;
        for(const group of row){
            for(const id of sccs[group]) {
                // Members of a cycle share a tier, but always get separate nodes.
                const x=direction==='LR'?level*mainGap:cursor*crossGap;
                const y=direction==='LR'?cursor*crossGap:level*mainGap;
                points.set(id,{x,y,cycleSize:sccs[group].length});cursor++;
            }
        }
        if(cursor!==count)throw new Error('Graph layout node counting mismatch');
    }
    const width=Math.max(NODE_WIDTH+40,...[...points.values()].map(p=>p.x+NODE_WIDTH+36));
    const height=Math.max(NODE_HEIGHT+40,...[...points.values()].map(p=>p.y+NODE_HEIGHT+36));
    return {points,width,height,cyclicGroups:sccs.filter(x=>x.length>1||f.get(x[0]).includes(x[0])).length};
}

export function layoutEvidenceGraph(nodes=[],edges=[],direction='LR'){
    const map=new Map();
    for(const node of nodes){const id=keyOf(node);if(id&&!map.has(id))map.set(id,node);}
    const ids=[...map.keys()].sort(nodeComparator);
    if(!ids.length)return {positions:new Map(),width:500,height:310,cyclicGroups:0,components:0};
    const forward=new Map(ids.map(id=>[id,[]]));
    const reverse=new Map(ids.map(id=>[id,[]]));
    const undirected=new Map(ids.map(id=>[id,new Set()]));
    const seen=new Set();
    for(const edge of edges){
        const a=String(edge?.source??''),b=String(edge?.target??'');
        if(!forward.has(a)||!forward.has(b))continue;
        const key=JSON.stringify([a,b]);if(seen.has(key))continue;seen.add(key);
        forward.get(a).push(b);reverse.get(b).push(a);
        undirected.get(a).add(b);undirected.get(b).add(a);
    }
    for(const list of [...forward.values(),...reverse.values()])list.sort(nodeComparator);
    const groups=connectedComponents(ids,undirected);
    // Pack disconnected subgraphs rather than forming a single giant column.
    const pieces=groups.map(group=>layoutComponent(group,forward,reverse,direction));
    const totalArea=pieces.reduce((s,p)=>s+(p.width+56)*(p.height+56),0);
    const rowTarget=Math.max(950,Math.min(4200,Math.sqrt(totalArea)*1.35));
    const positions=new Map();let x=30,y=30,rowH=0,totalW=0,cycles=0;
    for(const p of pieces){
        if(x>30&&x+p.width>rowTarget){x=30;y+=rowH+52;rowH=0;}
        for(const [id,v] of p.points)positions.set(id,{x:v.x+x,y:v.y+y,cycleSize:v.cycleSize});
        rowH=Math.max(rowH,p.height);totalW=Math.max(totalW,x+p.width);x+=p.width+55;cycles+=p.cyclicGroups;
    }
    return {positions,width:Math.max(500,totalW+36),height:Math.max(310,y+rowH+36),cyclicGroups:cycles,components:groups.length};
}

export function edgePath(a,b,direction='LR'){
    if(!a||!b)return '';
    const same=a.x===b.x&&a.y===b.y;
    if(direction==='LR'){
        const x1=a.x+NODE_WIDTH,y1=a.y+NODE_HEIGHT/2,x2=b.x,y2=b.y+NODE_HEIGHT/2;
        if(same || x2<=x1+25){const high=Math.min(y1,y2)-42;return `M${x1},${y1} L${x1+34},${y1} Q${x1+52},${high} ${x1+12},${high} L${x2-35},${high} Q${x2-55},${high} ${x2-35},${y2} L${x2},${y2}`;}
        const m=(x1+x2)/2;return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`;
    }
    const x1=a.x+NODE_WIDTH/2,y1=a.y+NODE_HEIGHT,x2=b.x+NODE_WIDTH/2,y2=b.y;
    if(same || y2<=y1+25){const side=Math.max(x1,x2)+NODE_WIDTH/2+42;return `M${x1},${y1} L${x1},${y1+26} Q${side},${y1+46} ${side},${y1+5} L${side},${y2-32} Q${side},${y2-54} ${x2},${y2-32} L${x2},${y2}`;}
    const m=(y1+y2)/2;return `M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`;
}
