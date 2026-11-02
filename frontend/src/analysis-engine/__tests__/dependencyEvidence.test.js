import { describe, expect, it } from 'vitest';
import { extractFileDependencies } from '../orchestrator.js';

describe('file dependency evidence', () => {
    it('resolves a relative TypeScript import and records the source line', () => {
        const files = [
            { path: 'src/main.ts', content: "import { User } from './models/User';\nexport const current = new User();" },
            { path: 'src/models/User.ts', content: 'export class User {}' },
        ];
        const edges = extractFileDependencies(files, []);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            source: 'src/main.ts', target: 'src/models/User.ts', type: 'import',
            resolution: 'resolved', confidence: 'high', line: 1,
        });
        expect(edges[0].evidence).toContain("./models/User");
    });

    it('reports unresolved relative imports instead of silently omitting them', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'src/main.ts', content: "import { missing } from './missing';" },
        ], [], diagnostics);
        expect(edges).toEqual([]);
        expect(diagnostics.unresolvedLocalImports).toEqual([
            { path: 'src/main.ts', line: 1, specifier: './missing' },
        ]);
    });

    it('does not invent a local edge for an external qualified Java import', () => {
        const files = [
            { path: 'src/App.java', content: 'package app;\nimport java.util.List;\nclass App {}' },
            { path: 'src/List.java', content: 'class List {}' },
        ];
        const classes = [
            { name: 'App', file: 'src/App.java', package: 'app', line: 3, annotations: [] },
            { name: 'List', file: 'src/List.java', package: null, line: 1, annotations: [] },
        ];
        expect(extractFileDependencies(files, classes)).toEqual([]);
    });

    it('marks duplicate class matches as ambiguous instead of high-confidence', () => {
        const files = [
            { path: 'src/Use.java', content: 'package app;\nimport com.example.Foo;\nclass Use { Foo value; }' },
            { path: 'src/a/Foo.java', content: 'package com.example;\nclass Foo {}' },
            { path: 'src/b/Foo.java', content: 'package com.example;\nclass Foo {}' },
        ];
        const classes = [
            { name: 'Use', file: 'src/Use.java', package: 'app', line: 3, annotations: [] },
            { name: 'Foo', file: 'src/a/Foo.java', package: 'com.example', line: 2, annotations: [] },
            { name: 'Foo', file: 'src/b/Foo.java', package: 'com.example', line: 2, annotations: [] },
        ];
        const edges = extractFileDependencies(files, classes);
        const importEdges = edges.filter((edge) => edge.source === 'src/Use.java' && edge.type === 'import');
        expect(importEdges).toHaveLength(2);
        expect(importEdges.every((edge) => edge.resolution === 'ambiguous' && edge.confidence === 'low')).toBe(true);
    });
});
