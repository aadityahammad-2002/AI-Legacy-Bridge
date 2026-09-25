/**
 * dependencies.js — Phase 3, batch 7 (Dependency/supply-chain).
 *
 *   1. Third-party dependency inventory — parses manifest files
 *      (package.json, requirements.txt, pyproject.toml, pom.xml,
 *      build.gradle, go.mod) into a flat {name, version, ecosystem} list.
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
        ['dependencies', 'devDependencies', 'peerDependencies'].forEach((section) => {
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
    const deps = [];
    const sectionMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|\Z)/);
    if (sectionMatch) {
        sectionMatch[1].split('\n').forEach((line) => {
            const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*"?([^"\n]*)"?/);
            if (m && m[1].toLowerCase() !== 'python') deps.push({ name: m[1], version: m[2] || 'unspecified', ecosystem: 'pypi', dev: false });
        });
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

const MANIFEST_PARSERS = [
    { re: /package\.json$/, parse: parsePackageJson },
    { re: /requirements.*\.txt$/, parse: parseRequirementsTxt },
    { re: /pyproject\.toml$/, parse: parsePyprojectToml },
    { re: /pom\.xml$/, parse: parsePomXml },
    { re: /build\.gradle(\.kts)?$/, parse: parseBuildGradle },
    { re: /go\.mod$/, parse: parseGoMod },
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
        confidenceReason: 'Parsed directly from manifest files (package.json, requirements.txt, pom.xml, build.gradle, go.mod) found in the repo.',
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
