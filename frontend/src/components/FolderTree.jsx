import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Folder, FileCode } from 'lucide-react';
import './FolderTree.css';

/** Builds a nested { name, path, children: Map, isFile } tree from flat file paths. */
function buildTree(paths) {
    const root = { name: '', path: '', children: new Map(), isFile: false };
    paths.forEach((path) => {
        const segments = path.split('/');
        let node = root;
        segments.forEach((seg, i) => {
            const isLast = i === segments.length - 1;
            const childPath = node.path ? `${node.path}/${seg}` : seg;
            if (!node.children.has(seg)) {
                node.children.set(seg, { name: seg, path: childPath, children: new Map(), isFile: isLast });
            }
            node = node.children.get(seg);
        });
    });
    return root;
}

function TreeNode({ node, depth, selectedPath, onSelectFile }) {
    const [expanded, setExpanded] = useState(depth < 1);
    const children = [...node.children.values()].sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return a.name.localeCompare(b.name);
    });

    if (node.isFile) {
        return (
            <div
                className={`folder-tree__row folder-tree__row--file${node.path === selectedPath ? ' folder-tree__row--selected' : ''}`}
                style={{ paddingLeft: 10 + depth * 14 }}
                onClick={() => onSelectFile(node.path)}
            >
                <FileCode size={13} strokeWidth={1.6} />
                <span>{node.name}</span>
            </div>
        );
    }

    return (
        <div>
            {depth >= 0 && (
                <div
                    className="folder-tree__row folder-tree__row--dir"
                    style={{ paddingLeft: 10 + depth * 14 }}
                    onClick={() => setExpanded((e) => !e)}
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Folder size={13} strokeWidth={1.6} />
                    <span>{node.name}</span>
                </div>
            )}
            {expanded &&
                children.map((child) => (
                    <TreeNode
                        key={child.path}
                        node={child}
                        depth={depth + 1}
                        selectedPath={selectedPath}
                        onSelectFile={onSelectFile}
                    />
                ))}
        </div>
    );
}

export default function FolderTree({ files, selectedPath, onSelectFile }) {
    const tree = useMemo(() => buildTree(files.map((f) => f.path)), [files]);
    return (
        <div className="folder-tree">
            <TreeNode node={tree} depth={-1} selectedPath={selectedPath} onSelectFile={onSelectFile} />
        </div>
    );
}
