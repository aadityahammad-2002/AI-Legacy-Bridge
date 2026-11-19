/** Pure presentation helpers for source-backed diagrams. Never create or infer graph edges. */
const NODE_WIDTH = 202;
const NODE_HEIGHT = 66;
const validNumber = value => Number.isFinite(value) ? value : 0;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/** Categories describe only metadata present in a node, not inferred services or runtime roles. */
export function describeDiagramNode(node = {}) {
    if (node.table || node.kind === 'table') {
        const columns = Array.isArray(node.table?.columns) ? node.table.columns.length : null;
        const fks = Array.isArray(node.table?.foreignKeys) ? node.table.foreignKeys.length : null;
        return {kind:'Database table',key:'table',accent:'#6bd6e4',fill:'#132e39',subtitle:[columns == null ? null : `${columns} columns`,fks == null ? null : `${fks} FKs`].filter(Boolean).join(' · '),file:node.table?.file||node.file||null,line:node.line??null};
    }
    if (node.kind === 'endpoint') return {kind:'API endpoint',key:'endpoint',accent:'#7ee1ad',fill:'#173529',subtitle:'Route declaration',file:node.file||null,line:node.line??null};
    if (node.kind === 'service-candidate') return {kind:'Service candidate',key:'service',accent:'#e2ba7c',fill:'#392c20',subtitle:`${Array.isArray(node.files)?node.files.length:0} files · not deployment proof`,file:null,line:null};
    if (node.kind === 'dependency'||node.kind === 'source'||node.file) return {kind:'Source code',key:'source',accent:'#b39bff',fill:'#2a2044',subtitle:node.file?String(node.file).split('/').pop():'File',file:node.file||null,line:node.line??null};
    if (Array.isArray(node.files)||Number.isFinite(node.fileCount)) {
        const count=Array.isArray(node.files)?node.files.length:node.fileCount;
        return {kind:'Module / tier',key:'module',accent:'#b99aff',fill:'#2a2142',subtitle:`${count} source files`,file:null,line:null};
    }
    return {kind:'Extracted symbol',key:'symbol',accent:'#a4b5e9',fill:'#232c40',subtitle:'Source-backed graph node',file:null,line:null};
}
export function diagramCategories(nodes = []) {
    const counts = new Map();
    for(const node of nodes){const d=describeDiagramNode(node);if(!counts.has(d.key))counts.set(d.key,{key:d.key,label:d.kind,color:d.accent,count:0});counts.get(d.key).count++;}
    return [...counts.values()];
}

/** SVG preserveAspectRatio=xMidYMid meet inserts letterbox margins; map pointers through those margins. */
export function viewportScale(view, viewportPixels) {
    if(!view||!viewportPixels||view.w<=0||view.h<=0||viewportPixels.width<=0||viewportPixels.height<=0)return null;
    const scale=Math.min(viewportPixels.width/view.w,viewportPixels.height/view.h);
    const displayW=view.w*scale,displayH=view.h*scale;
    return {scale,padX:(viewportPixels.width-displayW)/2,padY:(viewportPixels.height-displayH)/2,displayW,displayH};
}
export function pointerFractions(view, pixelRect, clientX, clientY){
    const mapping=viewportScale(view,pixelRect);
    if(!mapping)return {x:.5,y:.5};
    return {x:clamp((clientX-(pixelRect.left||0)-mapping.padX)/mapping.displayW,0,1),y:clamp((clientY-(pixelRect.top||0)-mapping.padY)/mapping.displayH,0,1)};
}
export function zoomViewport(view,pointer,factor,minWidth,maxWidth){
    if(!view||view.w<=0||view.h<=0)return view;
    const nextW=clamp(view.w*factor,minWidth,maxWidth),nextH=view.h*nextW/view.w;
    const fx=clamp(validNumber(pointer?.x),0,1),fy=clamp(validNumber(pointer?.y),0,1);
    return {x:view.x+fx*(view.w-nextW),y:view.y+fy*(view.h-nextH),w:nextW,h:nextH};
}
export function panViewport(view,rect,deltaX,deltaY){
    const mapping=viewportScale(view,rect);
    if(!mapping)return view;
    return {...view,x:view.x-deltaX/mapping.scale,y:view.y-deltaY/mapping.scale};
}
export function nodeCenterViewport(pos,layout,previous){
    if(!pos||!layout)return previous||null;
    const w=Math.max(480,Math.min(layout.width,920));
    const ratio=previous?.w>0&&previous?.h>0?previous.h/previous.w:Math.max(.4,Math.min(1.5,layout.height/layout.width));
    const h=w*ratio;
    return {x:pos.x+NODE_WIDTH/2-w/2,y:pos.y+NODE_HEIGHT/2-h/2,w,h};
}
