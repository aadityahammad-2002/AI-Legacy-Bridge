
let uidCounter = 0;
function nextId(prefix) {
    uidCounter += 1;
    return `${prefix}-${uidCounter}`;
}

/**
 * Deterministic local heuristic — same role as the old buildMockMigration(),
 * extended to tag a short title and one of the four categories shown in the
 * Overview card, and to keep the real source line number instead of
 * embedding it as a "// line N" comment. Used for the repo-wide "Generate
 * Full Migration Plan" sweep and as the fallback shown for a file until
 * "Run AI review" succeeds. Returns [] if nothing matches, rather than
 * inventing findings.
 */
export function scanFile(file) {
    const content = file.content || '';
    const lines = content.split('\n');
    const findings = [];
    const MAX_PER_FILE = 6;
    const isPython = /\.py$/.test(file.path);

    lines.forEach((line, i) => {
        if (findings.length >= MAX_PER_FILE) return;
        const lineNo = i + 1;
        const trimmed = line.trim();
        if (!trimmed) return;

        if (/\b(password|secret|api[_-]?key|token)\s*=\s*["'][^"']+["']/i.test(line)) {
            const varName = trimmed.split('=')[0].trim();
            const after = isPython
                ? `import os\n${varName} = os.environ.get("${varName.toUpperCase()}")`
                : `const ${varName} = process.env.${varName.toUpperCase()};`;
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Security', severity: 'High',
                title: 'Replace hardcoded secret with environment variable',
                explanation: 'Hardcoded secrets can be exposed in version control. Use environment variables instead for better security and flexibility.',
                before: trimmed, after, source: 'heuristic',
            });
        } else if (/\beval\s*\(/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Security', severity: 'High',
                title: 'Avoid eval() for dynamic code execution',
                explanation: 'eval() can execute arbitrary code and is a common injection vector. Parse or validate the input explicitly instead.',
                before: trimmed,
                after: '// Suggested: replace eval() with explicit parsing/validation of the expected input',
                source: 'heuristic',
            });
        } else if (isPython && /^import\s+urllib\s*$/.test(trimmed)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Deprecated APIs', severity: 'High',
                title: 'Replace deprecated import with new module',
                explanation: "Bare 'import urllib' is deprecated in modern Python. Import the specific submodule you need instead, e.g. urllib.parse for URL handling.",
                before: trimmed,
                after: 'from urllib import parse  # Use urllib.parse for URL handling',
                source: 'heuristic',
            });
        } else if (/function\s*\(.*\)\s*{\s*$/.test(line) && /callback|cb\)/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Deprecated APIs', severity: 'Medium',
                title: 'Convert callback to async/await',
                explanation: 'Callback-style functions are harder to read and compose than modern async/await. Consider converting this to an async function.',
                before: trimmed,
                after: '// Suggested: convert to an async function and use await instead of a callback parameter',
                source: 'heuristic',
            });
        } else if (/^(fastapi|django|flask|numpy|requests|spring-boot-starter)\s*==\s*[\d.]+/i.test(trimmed)
            || /"(react|express|axios|lodash)":\s*"[\^~]?[\d.]+"/i.test(trimmed)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Upgrades', severity: 'Medium',
                title: 'Update framework/dependency to a current release',
                explanation: "This dependency is pinned to a specific version. Check the package's changelog and consider upgrading to a current stable release for security fixes and performance improvements.",
                before: trimmed,
                after: '// Suggested: bump this pin after reviewing the changelog for breaking changes',
                source: 'heuristic',
            });
        } else if (/\bvar\s+\w+\s*=/.test(line)) {
            findings.push({
                id: nextId('h'), filePath: file.path, line: lineNo,
                category: 'Modernization', severity: 'Low',
                title: "Use 'const' or 'let' instead of 'var'",
                explanation: "'var' is function-scoped and can lead to subtle bugs. Prefer 'const' (or 'let' if reassigned) for block scoping.",
                before: trimmed,
                after: trimmed.replace(/\bvar\b/, 'const'),
                source: 'heuristic',
            });
        }
    });

    return findings;
}

export function scanRepository(files) {
    return files.flatMap((file) => scanFile(file));
}
