import { describe, expect, it } from 'vitest';
import { extractFileDependencies, extractLocalJsExportAliases } from '../moduleResolution.js';

describe('repository-local module resolution', () => {
    it('resolves multiline imports and preserves their source line', () => {
        const edges = extractFileDependencies([
            { path: 'src/main.ts', content: "import {\n  User,\n  Admin\n} from './models/User';\nexport const boot = true;" },
            { path: 'src/models/User.ts', content: 'export class User {}' },
        ]);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ source: 'src/main.ts', target: 'src/models/User.ts', line: 1, resolution: 'resolved' });
    });

    it('maps explicit .js runtime specifiers to TypeScript source files for TS importers', () => {
        const edges = extractFileDependencies([
            { path: 'src/main.ts', content: "import { run } from './service.js';\nrun();" },
            { path: 'src/service.ts', content: 'export function run() { return true; }' },
        ]);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            source: 'src/main.ts', target: 'src/service.ts', type: 'import',
            resolution: 'resolved', line: 1,
        });
    });

    it('captures named and wildcard re-export bindings without changing the target edge', () => {
        const named = extractFileDependencies([
            { path: 'src/barrel.ts', content: "export { run as execute } from './service.js';" },
            { path: 'src/service.ts', content: 'export function run() {}' },
        ]);
        expect(named).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'src/barrel.ts', target: 'src/service.ts', type: 're-export', resolution: 'resolved',
                importBindings: [expect.objectContaining({ importedName: 'run', localName: 'execute', exportedName: 'execute' })],
            }),
        ]));

        const star = extractFileDependencies([
            { path: 'src/barrel.ts', content: "export * from './service.js';" },
            { path: 'src/service.ts', content: 'export function run() {}' },
        ]);
        expect(star).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'src/barrel.ts', target: 'src/service.ts', type: 're-export',
                importBindings: [expect.objectContaining({ importedName: '*', localName: '*', exportedName: '*' })],
            }),
        ]));
    });

    it('ignores import-shaped text inside comments and template literals', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'src/main.ts', content: `/*\nimport { fake } from './comment-only.js';\n*/\nconst message = \`\nimport { hidden } from './template-only.js';\n\`;\nimport { real } from './real.js';` },
            { path: 'src/real.ts', content: 'export const real = true;' },
        ], [], diagnostics);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ source: 'src/main.ts', target: 'src/real.ts', resolution: 'resolved' });
        expect(diagnostics.unresolvedLocalImports).toEqual([]);
    });

    it('ignores import-shaped text inside Python docstrings and comments', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'pkg/main.py', content: `"""\nfrom .missing import fake\n"""\n# from .also_missing import hidden\ndef run():\n    return True\n` },
            { path: 'pkg/service.py', content: 'def service():\n    return True\n' },
        ], [], diagnostics);
        expect(edges).toEqual([]);
        expect(diagnostics.unresolvedLocalImports).toEqual([]);
    });

    it('extracts local export aliases without trusting comments or string text', () => {
        const aliases = extractLocalJsExportAliases(`/*\nexport { fake as hidden };\n*/\nconst text = "export { alsoFake as hidden2 };";\nfunction internalRun() {}\nexport { internalRun as publicRun };\nexport default function actualWork() {}`);
        expect(aliases.publicRun).toEqual(['internalRun']);
        expect(aliases.default).toEqual(['actualWork']);
        expect(aliases.hidden).toBeUndefined();
        expect(aliases.hidden2).toBeUndefined();
    });

    it('resolves TypeScript aliases from JSONC tsconfig files', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'tsconfig.json', content: '{\n  // project alias\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },\n}' },
            { path: 'src/app.ts', content: "import { User } from '@/models/User';" },
            { path: 'src/models/User.ts', content: 'export class User {}' },
        ], [], diagnostics);
        expect(edges).toHaveLength(1);
        expect(edges[0].target).toBe('src/models/User.ts');
        expect(diagnostics.pathMappings).toContainEqual({ pattern: '@/*', configPath: 'tsconfig.json' });
    });

    it('applies TypeScript .js-to-.ts substitution after a tsconfig path alias', () => {
        const edges = extractFileDependencies([
            { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/*"]}}}' },
            { path: 'src/main.ts', content: "import { run } from '@lib/service.js';" },
            { path: 'src/service.ts', content: 'export function run() {}' },
        ]);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ source: 'src/main.ts', target: 'src/service.ts', resolution: 'resolved' });
    });

    it('uses the nearest tsconfig scope in a monorepo instead of a sibling app alias', () => {
        const edges = extractFileDependencies([
            { path: 'tsconfig.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' },
            { path: 'src/shared.ts', content: 'export const rootShared = true;' },
            { path: 'apps/web/tsconfig.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}' },
            { path: 'apps/web/main.ts', content: "import { appShared } from '@/shared';" },
            { path: 'apps/web/src/shared.ts', content: 'export const appShared = true;' },
        ]);
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'apps/web/main.ts', target: 'apps/web/src/shared.ts', resolution: 'resolved' }),
        ]));
        expect(edges.some((edge) => edge.source === 'apps/web/main.ts' && edge.target === 'src/shared.ts')).toBe(false);
    });

    it('resolves Python package-relative imports, including `from . import sibling`', () => {
        const edges = extractFileDependencies([
            { path: 'service/pkg/__init__.py', content: 'from . import sibling\n' },
            { path: 'service/pkg/sibling.py', content: 'def call():\n    return True\n' },
            { path: 'service/pkg/nested/worker.py', content: 'from ..sibling import call\n' },
        ]);
        expect(edges).toHaveLength(2);
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'service/pkg/__init__.py', target: 'service/pkg/sibling.py', resolution: 'resolved' }),
            expect.objectContaining({ source: 'service/pkg/nested/worker.py', target: 'service/pkg/sibling.py', resolution: 'resolved' }),
        ]));
    });

    it('resolves `from . import module` members independently from the package root', () => {
        const files = [
            { path: 'service/pkg/__init__.py', content: 'from . import sibling, package_function\n' },
            { path: 'service/pkg/sibling.py', content: 'def call():\n    return True\n' },
        ];
        const diagnostics = {};
        const edges = extractFileDependencies(files, [], diagnostics);
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'service/pkg/__init__.py', target: 'service/pkg/sibling.py', type: 'from-import-module', resolution: 'resolved', resolvedBy: 'python-relative-package-member' }),
        ]));
        expect(diagnostics.ambiguousImports || []).toEqual([]);
        expect(diagnostics.unresolvedLocalImports || []).toEqual([]);
        expect(diagnostics.unresolvedPackageMembers).toEqual([
            expect.objectContaining({ path: 'service/pkg/__init__.py', importedName: 'package_function', semantics: expect.stringContaining('sibling module or a package attribute') }),
        ]);
    });

    it('treats Java wildcard-package candidates as inferred rather than ambiguous imports', () => {
        const files = [
            { path: 'app/Use.java', content: 'package app;\nimport app.dto.*;\nclass Use {}' },
            { path: 'app/dto/First.java', content: 'package app.dto; class First {}' },
            { path: 'app/dto/Second.java', content: 'package app.dto; class Second {}' },
        ];
        const classes = [
            { name: 'Use', file: 'app/Use.java', package: 'app', line: 3 },
            { name: 'First', file: 'app/dto/First.java', package: 'app.dto', line: 1 },
            { name: 'Second', file: 'app/dto/Second.java', package: 'app.dto', line: 1 },
        ];
        const diagnostics = {};
        const edges = extractFileDependencies(files, classes, diagnostics);
        expect(edges.filter((edge) => edge.source === 'app/Use.java')).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: 'app/dto/First.java', type: 'wildcard-import', resolution: 'inferred' }),
            expect.objectContaining({ target: 'app/dto/Second.java', type: 'wildcard-import', resolution: 'inferred' }),
        ]));
        expect(diagnostics.ambiguousImports || []).toEqual([]);
    });

    it('does not infer same-package edges from Java comments or string literals', () => {
        const files = [
            { path: 'src/A.java', content: 'package app;\n// Foo is not used here\nString text = "Foo";\nclass A {}' },
            { path: 'src/Foo.java', content: 'package app;\nclass Foo {}' },
        ];
        const classes = [
            { name: 'A', file: 'src/A.java', package: 'app', line: 4 },
            { name: 'Foo', file: 'src/Foo.java', package: 'app', line: 2 },
        ];
        expect(extractFileDependencies(files, classes)).toEqual([]);
    });

    it('still marks unresolved explicit relative imports instead of claiming coverage', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([{ path: 'src/a.ts', content: "import { x } from './missing';" }], [], diagnostics);
        expect(edges).toEqual([]);
        expect(diagnostics.unresolvedLocalImports).toEqual([
            { path: 'src/a.ts', line: 1, specifier: './missing' },
        ]);
    });


    it('inherits tsconfig paths from an in-repository base config', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'apps/web/tsconfig.base.json', content: '{"compilerOptions":{"baseUrl":".","paths":{"@base/*":["src/*"]}}}' },
            { path: 'apps/web/tsconfig.json', content: '{"extends":"./tsconfig.base.json"}' },
            { path: 'apps/web/main.ts', content: "import { shared } from '@base/shared';" },
            { path: 'apps/web/src/shared.ts', content: 'export const shared = true;' },
        ], [], diagnostics);
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'apps/web/main.ts', target: 'apps/web/src/shared.ts', resolution: 'resolved', resolvedBy: 'tsconfig-path-mapping' }),
        ]));
    });

    it('resolves in-repository workspace package exports and scoped package imports', () => {
        const files = [
            { path: 'packages/core/package.json', content: JSON.stringify({
                name: '@demo/core',
                exports: { '.': { types: './src/index.d.ts', import: './src/index.js' }, './utils/*': './src/utils/*.js' },
                imports: { '#internal/*': './src/internal/*.js' },
            }) },
            { path: 'packages/core/src/index.ts', content: 'export const root = true;' },
            { path: 'packages/core/src/utils/format.ts', content: 'export const format = (x) => x;' },
            { path: 'packages/core/src/internal/run.ts', content: 'export const run = () => true;' },
            { path: 'packages/core/src/use-internal.ts', content: "import { run } from '#internal/run';" },
            { path: 'apps/web/main.ts', content: "import { root } from '@demo/core';\nimport { format } from '@demo/core/utils/format';\nimport react from 'react';" },
        ];
        const diagnostics = {};
        const edges = extractFileDependencies(files, [], diagnostics);
        expect(edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: 'apps/web/main.ts', target: 'packages/core/src/index.ts', resolvedBy: 'workspace-package-manifest', resolution: 'resolved' }),
            expect.objectContaining({ source: 'apps/web/main.ts', target: 'packages/core/src/utils/format.ts', resolvedBy: 'workspace-package-manifest', resolution: 'resolved' }),
            expect.objectContaining({ source: 'packages/core/src/use-internal.ts', target: 'packages/core/src/internal/run.ts', resolvedBy: 'package-import-map', resolution: 'resolved' }),
        ]));
        expect(diagnostics.unresolvedLocalImports).toEqual([]);
    });

    it('does not mark missing external bare imports as unresolved local dependencies', () => {
        const diagnostics = {};
        const edges = extractFileDependencies([
            { path: 'src/main.ts', content: "import React from 'react';\nimport { useMemo } from 'some-external-library';" },
        ], [], diagnostics);
        expect(edges).toEqual([]);
        expect(diagnostics.unresolvedLocalImports).toEqual([]);
    });

    it('ignores Java import-shaped lines inside comments and text blocks', () => {
        const source = [
            'package demo;',
            '/*',
            'import demo.FakeComment;',
            '*/',
            'class Example {',
            '  String note = """',
            '  import demo.FakeTextBlock;',
            '  """;',
            '}',
        ].join('\n');
        const files = [
            { path: 'src/demo/Example.java', content: source },
            { path: 'src/demo/FakeComment.java', content: 'package demo; class FakeComment {}' },
            { path: 'src/demo/FakeTextBlock.java', content: 'package demo; class FakeTextBlock {}' },
        ];
        const classes = [
            { name: 'Example', file: 'src/demo/Example.java', package: 'demo', line: 5 },
            { name: 'FakeComment', file: 'src/demo/FakeComment.java', package: 'demo', line: 1 },
            { name: 'FakeTextBlock', file: 'src/demo/FakeTextBlock.java', package: 'demo', line: 1 },
        ];
        expect(extractFileDependencies(files, classes)).toEqual([]);
    });

    it('collects multiple import declarations on the same line', () => {
        const files = [
            { path: 'src/main.ts', content: "import './side-effect.js'; import { value } from './value.js';" },
            { path: 'src/side-effect.ts', content: 'export const initialized = true;' },
            { path: 'src/value.ts', content: 'export const value = 1;' },
        ];
        const edges = extractFileDependencies(files);
        expect(edges).toHaveLength(2);
        expect(edges.map((edge) => edge.target)).toEqual(expect.arrayContaining(['src/side-effect.ts', 'src/value.ts']));
    });

});
