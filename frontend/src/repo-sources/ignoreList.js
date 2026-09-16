/**
 * Shared file/folder exclusion rules for all repo sources (zip, local
 * folder, GitHub) — single source of truth, imported by zip.js,
 * localFolder.js, and github.js rather than duplicated in each.
 *
 * Three layers of filtering:
 *   1. DEFAULT_EXCLUDED_DIRS — folder names skipped wholesale (anything
 *      nested inside is skipped too, without needing to list it separately)
 *   2. EXCLUDED_FILENAMES — exact loose filenames skipped wherever they appear
 *   3. EXCLUDED_EXTENSIONS — file types that are never source/config worth
 *      analyzing (binaries, logs, compiled output), regardless of folder
 */

export const DEFAULT_EXCLUDED_DIRS = [
    // --- Version control ---
    '.git', '.svn', '.hg',

    // --- Node / JS / TS / frontend build tooling ---
    'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
    'coverage', '.turbo', '.parcel-cache', '.cache', '.vite', '.output',
    'bower_components',

    // --- Python ---
    '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache',
    '.pytest_cache', '.ruff_cache', '.eggs', 'site-packages',

    // --- Java / Maven / Gradle ---
    'target', '.gradle', 'gradle',

    // --- .NET / C# ---
    'bin', 'obj', '.vs',

    // --- Ruby ---
    '.bundle', 'vendor/bundle',

    // --- Go / Rust / PHP / generic vendored deps ---
    'vendor',

    // --- Rust ---
    // 'target' already covered above (shared with Java/Maven)

    // --- Editors / IDEs ---
    '.idea', '.vscode', '.settings', '.eclipse',

    // --- Eclipse workspace metadata (appears when a whole Eclipse
    //     workspace gets zipped instead of just the project folder;
    //     excluding these two alone also skips every org.eclipse.*
    //     plugin-id subfolder nested under them) ---
    '.metadata', '.plugins',

    // --- Misc CI / workspace noise (repo-specific, not universal — see
    //     caveat below) ---
    '.github', 'modernize',
];

const EXCLUDED_FILENAMES = [
    // Eclipse loose files
    '.lock', 'javaLikeNames.txt', 'savedIndexNames.txt', 'versions.json',
    'launchConfigurationHistory.xml', 'dialog_settings.xml',
    'workspacestate.properties', 'clean-cache.properties',
    'OpenTypeHistory.xml', 'QualifiedTypeNameHistory.xml',
    '.install.xml', 'libraryInfos.xml',

    // IntelliJ
    '.iml',

    // OS-generated
    '.DS_Store', 'Thumbs.db', 'desktop.ini',

    // Lockfiles that are huge and rarely worth chunking/parsing as "code"
    // (kept OUT of this list deliberately if you want dependency-graph
    // awareness of them — add here only if you want them fully skipped)
];

const EXCLUDED_EXTENSIONS = [
    // Compiled/binary output
    '.class', '.pyc', '.pyo', '.o', '.obj', '.exe', '.dll', '.so', '.dylib',
    '.jar', '.war', '.ear',

    // Logs and caches
    '.log',

    // Common binary/media (analysis engine's own isBinary check should also
    // catch most of these, but excluding by extension avoids even reading
    // the file bytes to check)
    '.min.js', '.min.css',
];

export function shouldSkipPath(path) {
    const segments = path.split('/');
    if (segments.some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg))) return true;

    const filename = segments[segments.length - 1];
    if (EXCLUDED_FILENAMES.includes(filename)) return true;

    const lowerName = filename.toLowerCase();
    if (EXCLUDED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) return true;

    return false;
}