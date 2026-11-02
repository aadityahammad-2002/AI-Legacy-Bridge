/** Heuristic, ecosystem-aware manifest-to-import linkage. Findings are candidates only. */
const KNOWN_PYTHON_IMPORT_NAMES = {
    pillow: 'PIL', pyyaml: 'yaml', 'scikit-learn': 'sklearn', beautifulsoup4: 'bs4',
    opencv_python: 'cv2', 'opencv-python': 'cv2', 'python-dateutil': 'dateutil',
    'python-dotenv': 'dotenv', attrs: 'attr',
};

function normalizePackageName(value) { return String(value || '').toLowerCase().replace(/[-_.]+/g, '-'); }
function npmTopLevel(name) {
    const parts = String(name || '').split('/');
    return String(name || '').startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectImports(files) {
    const imports = { npm: new Set(), python: new Set(), java: new Set(), go: new Set(), cargo: new Set(), rubygems: new Set(), all: [] };
    for (const file of files || []) {
        const path = String(file.path || '').replace(/\\/g, '/');
        const content = String(file.content || '');
        const js = /\.(?:[cm]?js|jsx|tsx?)$/i.test(path);
        const py = /\.(?:py|pyw|pyi)$/i.test(path);
        const jvm = /\.(?:java|kt|kts|scala|groovy)$/i.test(path);
        const goFile = /\.go$/i.test(path);
        const rustFile = /\.rs$/i.test(path);
        const rubyFile = /\.rb$/i.test(path);

        if (js) {
            const re = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
            for (const match of content.matchAll(re)) {
                const specifier = match[1] || match[2];
                if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) continue;
                const name = npmTopLevel(specifier);
                imports.npm.add(name); imports.all.push({ ecosystem: 'npm', name, specifier, file: path });
            }
        } else if (py) {
            const re = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm;
            for (const match of content.matchAll(re)) {
                const raw = (match[1] || match[2] || '').split(',')[0].trim();
                if (!raw || raw.startsWith('.')) continue;
                const name = raw.split('.')[0];
                imports.python.add(name); imports.all.push({ ecosystem: 'pypi', name, specifier: raw, file: path });
            }
        } else if (jvm) {
            const re = /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/gm;
            for (const match of content.matchAll(re)) {
                const specifier = match[1];
                imports.java.add(specifier); imports.all.push({ ecosystem: 'maven', name: specifier, specifier, file: path });
            }
        } else if (goFile) {
            const re = /^\s*import\s+(?:\w+\s+)?["`]([^"`]+)["`]/gm;
            for (const match of content.matchAll(re)) {
                const specifier = match[1];
                imports.go.add(specifier); imports.all.push({ ecosystem: 'go', name: specifier, specifier, file: path });
            }
        } else if (rustFile) {
            const re = /^\s*(?:pub\s+)?use\s+([A-Za-z_][\w]*)/gm;
            for (const match of content.matchAll(re)) {
                const name = match[1];
                imports.cargo.add(name); imports.all.push({ ecosystem: 'cargo', name, specifier: name, file: path });
            }
            const externRe = /^\s*extern\s+crate\s+([A-Za-z_][\w]*)/gm;
            for (const match of content.matchAll(externRe)) {
                const name = match[1];
                imports.cargo.add(name); imports.all.push({ ecosystem: 'cargo', name, specifier: name, file: path });
            }
        } else if (rubyFile) {
            const re = /^\s*require(?:_relative)?\s*\(?\s*["']([^"']+)["']/gm;
            for (const match of content.matchAll(re)) {
                const name = match[1].split('/')[0];
                imports.rubygems.add(name); imports.all.push({ ecosystem: 'rubygems', name, specifier: match[1], file: path });
            }
        }
    }
    return imports;
}

function packageLikelyUsed(dep, imports) {
    if (dep.ecosystem === 'npm') {
        const name = npmTopLevel(dep.name);
        return imports.npm.has(name) || (name.startsWith('@') && [...imports.npm].some((entry) => entry.startsWith(`${name}/`)));
    }
    if (dep.ecosystem === 'pypi') {
        const original = String(dep.name).toLowerCase().replace(/_/g, '-');
        const importName = KNOWN_PYTHON_IMPORT_NAMES[original] || String(dep.name).replace(/-/g, '_').replace(/\./g, '_');
        return imports.python.has(importName.split('.')[0]) || imports.python.has(String(dep.name).split(/[.-]/)[0]);
    }
    if (dep.ecosystem === 'go') {
        const module = String(dep.name);
        return [...imports.go].some((item) => item === module || item.startsWith(`${module}/`) || module.endsWith(`/${item}`));
    }
    if (dep.ecosystem === 'cargo') {
        const crate = String(dep.name).replace(/-/g, '_');
        return imports.cargo.has(crate) || imports.cargo.has(String(dep.name));
    }
    if (dep.ecosystem === 'rubygems') {
        const name = normalizePackageName(dep.name);
        return [...imports.rubygems].some((item) => normalizePackageName(item) === name);
    }
    // JVM, Composer and Hex package names do not map reliably to import namespaces.
    return null;
}

export function analyzeDependencyUsage(files = [], dependencyInventory = { dependencies: [] }) {
    const imports = collectImports(files);
    const dependencies = Array.isArray(dependencyInventory.dependencies) ? dependencyInventory.dependencies : [];
    const results = dependencies.map((dependency) => {
        const staticUse = packageLikelyUsed(dependency, imports);
        const status = staticUse === true ? 'static-import-detected' : staticUse === false ? 'no-static-import-detected' : 'not-statically-mappable';
        return {
            ...dependency,
            status,
            candidate: staticUse === false,
            confidence: staticUse === true ? 'medium' : staticUse === false ? 'low' : 'unknown',
            evidence: staticUse === true
                ? imports.all.filter((item) => item.ecosystem === dependency.ecosystem && (item.name === dependency.name || item.name === npmTopLevel(dependency.name) || item.specifier.includes(dependency.name))).slice(0, 10)
                : [],
            reason: staticUse === false
                ? 'No matching static import was found in scanned files. Dynamic loading, framework plugins, generated registration, test-only usage, or name-to-artifact mapping may hide usage.'
                : staticUse === null
                    ? 'This ecosystem does not support reliable manifest-name to import-name matching in this pass; no unused-dependency claim is made.'
                    : 'At least one matching static import was found; actual runtime usage is not proven.',
        };
    });
    return {
        schemaVersion: 1,
        status: 'partial',
        totalDependencies: dependencies.length,
        staticUseDetected: results.filter((item) => item.status === 'static-import-detected').length,
        unusedCandidates: results.filter((item) => item.candidate).length,
        notStaticallyMappable: results.filter((item) => item.status === 'not-statically-mappable').length,
        imports: imports.all.slice(0, 5000),
        dependencies: results,
        candidates: results.filter((item) => item.candidate),
        semantics: 'Static import matching is heuristic. A missing import is a review candidate, not proof a dependency is unused. JVM, Composer and Hex artifact-to-import mapping is intentionally not guessed.',
    };
}
