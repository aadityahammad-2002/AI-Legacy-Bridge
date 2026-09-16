/**
 * repo-sources/github.js
 *
 * Fetches a GitHub repository's files directly from the browser (no backend proxy, so no server ever sees the
 * repository content or the user's token). Uses the Git Trees API for a
 * single-request file listing, then fetches each file's content via the
 * Contents API with bounded concurrency.
 *
 * Output shape matches what `analyzeRepository()` expects: [{ path, content }]
 */

import { Parser } from '../analysis-engine/parser.js';

const API_BASE = 'https://api.github.com';
const DEFAULT_EXCLUDED_DIRS = [
    'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target',
    '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv',
];
const MAX_FILE_SIZE_BYTES = 500 * 1024; // 500KB — skip huge generated/minified files
const CONCURRENCY = 8;

export class GitHubRateLimitError extends Error {}
export class GitHubNotFoundError extends Error {}

/** Parses "https://github.com/owner/repo", "owner/repo", or with a trailing .git into { owner, repo }. */
export function parseGitHubUrl(input) {
    const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
    const match = cleaned.match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+)$/);
    if (!match) throw new Error(`Could not parse a GitHub owner/repo from: ${input}`);
    return { owner: match[1], repo: match[2] };
}

async function githubRequest(url, token) {
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, { headers });
    const remaining = res.headers.get('x-ratelimit-remaining');

    if (!res.ok) {
        if (res.status === 404) throw new GitHubNotFoundError('Repository not found (or private without a token).');
        if (res.status === 403 || res.status === 429) {
            throw new GitHubRateLimitError(
                token
                    ? 'GitHub API rate limit reached for this token.'
                    : 'GitHub API rate limit reached (60 req/hour without a token). Add a personal access token for 5,000 req/hour.'
            );
        }
        throw new Error(`GitHub API error ${res.status}`);
    }
    return { data: await res.json(), rateLimitRemaining: remaining ? parseInt(remaining, 10) : null };
}

function decodeBase64Utf8(base64) {
    const binary = atob(base64.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

function shouldSkipPath(path) {
    const segments = path.split('/');
    return segments.some((seg) => DEFAULT_EXCLUDED_DIRS.includes(seg));
}

/**
 * Lists all file blobs in the repo's default branch via the Git Trees API
 * (one request, recursive=1). Falls back to noting truncation if GitHub
 * truncates a very large tree.
 */
async function listRepoFiles(owner, repo, token, onProgress) {
    onProgress?.({ phase: 'listing', message: 'Fetching repository info...' });
    const { data: repoInfo } = await githubRequest(`${API_BASE}/repos/${owner}/${repo}`, token);
    const branch = repoInfo.default_branch || 'main';

    onProgress?.({ phase: 'listing', message: `Listing files on ${branch}...` });
    const { data: tree } = await githubRequest(
        `${API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        token
    );
    if (!tree.tree) throw new Error('Unexpected response from GitHub Trees API.');

    const files = tree.tree.filter((item) => {
        if (item.type !== 'blob') return false;
        if (shouldSkipPath(item.path)) return false;
        if (item.size && item.size > MAX_FILE_SIZE_BYTES) return false;
        const name = item.path.split('/').pop();
        if (!Parser.isIncluded(name)) return false; // skip binaries/unsupported types
        return true;
    });

    return { files, truncated: !!tree.truncated };
}

/** Fetches raw content for one file via the Contents API. */
async function fetchFileContent(owner, repo, path, token) {
    const { data } = await githubRequest(
        `${API_BASE}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
        token
    );
    if (!data.content) return null;
    return decodeBase64Utf8(data.content);
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

/**
 * Fetches every (non-excluded, non-huge) file in a GitHub repository.
 *
 * @param {string} repoUrlOrSlug - e.g. "https://github.com/facebook/react" or "facebook/react"
 * @param {string} [token] - optional personal access token (for private repos / higher rate limit)
 * @param {(p: { phase: string, message?: string, current?: number, total?: number }) => void} [onProgress]
 * @returns {Promise<{ repoMeta: object, files: Array<{path: string, content: string}>, truncated: boolean }>}
 */
export async function fetchGitHubRepository(repoUrlOrSlug, token, onProgress) {
    const { owner, repo } = parseGitHubUrl(repoUrlOrSlug);
    const { files: fileList, truncated } = await listRepoFiles(owner, repo, token, onProgress);

    onProgress?.({ phase: 'downloading', current: 0, total: fileList.length });
    let completed = 0;
    const files = await mapWithConcurrency(fileList, CONCURRENCY, async (item) => {
        let content = null;
        try {
            content = await fetchFileContent(owner, repo, item.path, token);
        } catch (err) {
            console.warn(`[github] failed to fetch ${item.path}:`, err.message);
        }
        completed++;
        onProgress?.({ phase: 'downloading', current: completed, total: fileList.length });
        return content !== null ? { path: item.path, content } : null;
    });

    return {
        repoMeta: { name: repo, source: 'github', url: `https://github.com/${owner}/${repo}` },
        files: files.filter(Boolean),
        truncated,
    };
}
