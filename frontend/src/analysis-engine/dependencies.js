/**
 * dependencies.js — Phase 3, batch 7 (Dependency/supply-chain).
 *
 *   1. Third-party dependency inventory — parses manifest files
 *      (npm, Python, Maven/Gradle, Go, Cargo, Composer, Ruby and Mix manifests)
 *      into a flat {name, version, ecosystem} list.
 *   2. License compliance check — best-effort only. This engine runs
 *      entirely offline against the files it's given; it does NOT call
 *      npm/PyPI/Maven registries to fetch real license metadata. It can
 *      only classify against a small built-in table of well-known
 *      packages' typical licenses. Anything not in that table is reported
 *      as UNKNOWN, not "compliant" — never silently assumed permissive.
 */

// ---------------------------------------------------------------------
// 1. Dependency inventory
// ---------------------------------------------------------------------

function parsePackageJson(content) {
    try {
        const pkg = JSON.parse(content);
        const deps = [];
        ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].forEach((section) => {
            Object.entries(pkg[section] || {}).forEach(([name, version]) => {
                deps.push({ name, version: String(version), ecosystem: 'npm', dev: section === 'devDependencies' });
            });
        });
        return deps;
    } catch {
        return [];
    }
}

function parseRequirementsTxt(content) {
    return content.split('\n')
        .map((l) => l.split('#')[0].trim())
        .filter((l) => l && !l.startsWith('-'))
        .map((l) => {
            const m = l.match(/^([A-Za-z0-9_.\-]+)\s*(==|>=|<=|~=|!=|>|<)?\s*([\w.*]*)/);
            return m ? { name: m[1], version: m[3] || 'unspecified', ecosystem: 'pypi', dev: false } : null;
        })
        .filter(Boolean);
}

function parsePyprojectToml(content) {
    const source = String(content || '');
    const deps = [];
    const poetryMatch = source.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (poetryMatch) {
        poetryMatch[1].split(/\r?\n/).forEach((line) => {
            const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/);
            if (match && match[1].toLowerCase() !== 'python') deps.push({ name: match[1], version: match[2] || match[3] || 'unspecified', ecosystem: 'pypi', dev: false });
        });
    }
    const projectMatch = source.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
    if (projectMatch) {
        const arrayMatch = projectMatch[1].match(/\bdependencies\s*=\s*\[([\s\S]*?)\]/);
        for (const item of (arrayMatch?.[1] || '').matchAll(/["']([^"']+)["']/g)) {
            const spec = item[1].trim();
            const packageMatch = spec.match(/^([A-Za-z0-9_.-]+)/);
            if (packageMatch) deps.push({ name: packageMatch[1], version: spec.slice(packageMatch[0].length).trim() || 'unspecified', ecosystem: 'pypi', dev: false });
        }
    }
    const optionalBlock = source.match(/\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/);
    if (optionalBlock) {
        for (const item of optionalBlock[1].matchAll(/["']([^"']+)["']/g)) {
            const spec = item[1].trim();
            const packageMatch = spec.match(/^([A-Za-z0-9_.-]+)/);
            if (packageMatch) deps.push({ name: packageMatch[1], version: spec.slice(packageMatch[0].length).trim() || 'unspecified', ecosystem: 'pypi', dev: true });
        }
    }
    return deps;
}

function parsePomXml(content) {
    const deps = [];
    const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
    let m;
    while ((m = depRe.exec(content)) !== null) {
        const block = m[1];
        const artifactId = (block.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1];
        const groupId = (block.match(/<groupId>([^<]+)<\/groupId>/) || [])[1];
        const version = (block.match(/<version>([^<]+)<\/version>/) || [])[1] || 'managed';
        if (artifactId) deps.push({ name: `${groupId || '?'}:${artifactId}`, version, ecosystem: 'maven', dev: false });
    }
    return deps;
}

function parseBuildGradle(content) {
    const deps = [];
    const re = /(?:implementation|api|compile|testImplementation|runtimeOnly)\s*\(?['"]([\w.\-]+):([\w.\-]+):([\w.\-+]+)['"]\)?/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        deps.push({ name: `${m[1]}:${m[2]}`, version: m[3], ecosystem: 'maven', dev: /testImplementation/.test(m[0]) });
    }
    return deps;
}

function parseGoMod(content) {
    const deps = [];
    const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
    const lines = requireBlock ? requireBlock[1].split('\n') : content.split('\n').filter((l) => l.trim().startsWith('require '));
    lines.forEach((line) => {
        const m = line.replace(/^require\s+/, '').match(/^\s*([\w.\-/]+)\s+([\w.\-+]+)/);
        if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'go', dev: false });
    });
    return deps;
}

function parseCargoToml(content) {
    const deps = [];
    let section = '';
    const lines = String(content || '').split(/\r?\n/);
    for (const line of lines) {
        const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (heading) { section = heading[1].trim(); continue; }
        if (!/(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)$/.test(section)) continue;
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/);
        if (!match) continue;
        deps.push({ name: match[1], version: match[2] || match[3] || 'unspecified', ecosystem: 'cargo', dev: /dev-dependencies|build-dependencies/.test(section) });
    }
    return deps;
}

function parseComposerJson(content) {
    try {
        const composer = JSON.parse(content);
        const deps = [];
        for (const section of ['require', 'require-dev']) {
            Object.entries(composer[section] || {}).forEach(([name, version]) => {
                if (name === 'php' || name.startsWith('ext-') || name.startsWith('lib-')) return;
                deps.push({ name, version: String(version), ecosystem: 'composer', dev: section === 'require-dev' });
            });
        }
        return deps;
    } catch { return []; }
}

function parseGemfile(content) {
    const deps = [];
    const re = /^\s*gem\s+['"]([A-Za-z0-9_.-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm;
    for (const match of String(content || '').matchAll(re)) {
        deps.push({ name: match[1], version: match[2] || 'unspecified', ecosystem: 'rubygems', dev: /group\s*:\s*(?:test|development)/i.test(match[0]) });
    }
    return deps;
}

function parseMixExs(content) {
    const deps = [];
    const re = /\{\s*:([a-zA-Z0-9_]+)\s*,\s*"([^"\n]+)"/g;
    for (const match of String(content || '').matchAll(re)) {
        deps.push({ name: match[1], version: match[2], ecosystem: 'hex', dev: false });
    }
    return deps;
}

const MANIFEST_PARSERS = [
    { re: /package\.json$/, parse: parsePackageJson },
    { re: /requirements.*\.txt$/, parse: parseRequirementsTxt },
    { re: /pyproject\.toml$/, parse: parsePyprojectToml },
    { re: /pom\.xml$/, parse: parsePomXml },
    { re: /build\.gradle(\.kts)?$/, parse: parseBuildGradle },
    { re: /go\.mod$/, parse: parseGoMod },
    { re: /Cargo\.toml$/i, parse: parseCargoToml },
    { re: /composer\.json$/i, parse: parseComposerJson },
    { re: /Gemfile$/, parse: parseGemfile },
    { re: /mix\.exs$/, parse: parseMixExs },
];

/** Builds a de-duplicated third-party dependency inventory across manifests. */
export function extractDependencyInventory(files) {
    const all = [];
    files.forEach((f) => {
        const parser = MANIFEST_PARSERS.find((p) => p.re.test(f.path));
        if (!parser) return;
        parser.parse(f.content || '').forEach((dep) => all.push({ ...dep, manifestFile: f.path }));
    });

    const seen = new Set();
    const deduped = all.filter((d) => {
        const key = `${d.ecosystem}:${d.name}:${d.version}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return {
        dependencies: deduped,
        totalCount: deduped.length,
        byEcosystem: deduped.reduce((acc, d) => { acc[d.ecosystem] = (acc[d.ecosystem] || 0) + 1; return acc; }, {}),
        confidence: 'FACT',
        confidenceReason: 'Parsed from supported manifest files found in the supplied repository snapshot; text parsers may not cover every manifest feature.',
    };
}

// ---------------------------------------------------------------------
// 2. License compliance (best-effort, offline)
// ---------------------------------------------------------------------

// Deliberately small — only extremely common packages whose license is
// stable and well-known. Anything else is UNKNOWN, never guessed.
const KNOWN_LICENSES = {
    'react': 'MIT', 'react-dom': 'MIT', 'vue': 'MIT', 'express': 'MIT', 'lodash': 'MIT',
    'axios': 'MIT', 'flask': 'BSD-3-Clause', 'django': 'BSD-3-Clause', 'requests': 'Apache-2.0',
    'numpy': 'BSD-3-Clause', 'pandas': 'BSD-3-Clause', 'spring-boot-starter': 'Apache-2.0',
    'serde': 'MIT OR Apache-2.0', 'clap': 'MIT OR Apache-2.0', 'rails': 'MIT', 'phoenix': 'MIT',
    'junit': 'EPL-2.0', 'mysql-connector-java': 'GPL-2.0', 'org.springframework:spring-core': 'Apache-2.0',
};

const COPYLEFT_RE = /^(GPL|AGPL|LGPL|CC-BY-SA|MPL)/i;

function classifyLicense(license) {
    if (!license) return 'unknown';
    return COPYLEFT_RE.test(license) ? 'copyleft' : 'permissive';
}

/**
 * Checks each inventoried dependency against the small known-license
 * table. This is explicitly NOT a real compliance audit — it cannot see
 * licenses this engine doesn't already know, and doesn't call out to any
 * registry. Its only real job is to flag the copyleft licenses it CAN
 * identify (which typically carry the most legal risk to review) and to
 * be honest about everything it can't identify, rather than silently
 * assuming those are fine.
 */
export function checkLicenseCompliance(inventory) {
    const results = inventory.dependencies.map((dep) => {
        const shortName = dep.name.split(':').pop();
        const license = KNOWN_LICENSES[dep.name] || KNOWN_LICENSES[shortName] || null;
        const classification = classifyLicense(license);
        return {
            name: dep.name, version: dep.version, ecosystem: dep.ecosystem,
            license: license || 'unknown', classification,
            confidence: license ? 'FACT' : 'UNCERTAIN',
            confidenceReason: license
                ? `"${dep.name}" is a well-known package with a stable, documented license.`
                : `License not in this engine's small built-in table — this engine works offline and does not query npm/PyPI/Maven registries. Verify manually via the package's registry page.`,
        };
    });

    const copyleftFlags = results.filter((r) => r.classification === 'copyleft');
    const unknownCount = results.filter((r) => r.classification === 'unknown').length;

    return {
        results, copyleftFlags, unknownCount, totalChecked: results.length,
        note: 'Best-effort, offline check against a small built-in table of common packages. Not a substitute for a real license-compliance tool with live registry access.',
    };
}
