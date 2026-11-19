import { asArray, safePath } from './workspaceData.js';

export function buildFileTree(files) {
    const root={name:'root',path:'',folders:new Map(),files:[]};
    for(const f of asArray(files)){
        const path=safePath(f?.path);if(!path)continue;
        const parts=path.split('/'); let dir=root;
        for(const name of parts.slice(0,-1)){
            if(!dir.folders.has(name))dir.folders.set(name,{name,path:dir.path?`${dir.path}/${name}`:name,folders:new Map(),files:[]});
            dir=dir.folders.get(name);
        }
        dir.files.push({name:parts.at(-1),path,file:f});
    }
    const sort=(dir)=>{
        dir.children=[...dir.folders.values()].sort((a,b)=>a.name.localeCompare(b.name));
        dir.files.sort((a,b)=>a.name.localeCompare(b.name));
        for(const child of dir.children)sort(child);
        delete dir.folders;
    };
    sort(root);return root;
}

/** Select a source record without inventing a path. In dashboard mode the
 * repository-scoped focus is authoritative; clearing it returns to the first
 * available file rather than resurfacing a stale local selection. */
export function selectRepositoryFile(files, focusedPath = null, localPath = null, controlled = false) {
    const rows=asArray(files).filter(item => safePath(item?.path));
    const requested=controlled ? focusedPath : localPath;
    return rows.find(item => item.path === requested) || rows[0] || null;
}
