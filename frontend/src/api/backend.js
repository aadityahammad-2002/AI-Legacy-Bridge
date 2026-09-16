/**
 * api/backend.js
 *
 * Thin client for the Spring Boot backend. Kept separate from the analysis
 * engine and repo-sources — those never know the backend exists.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

// The AI Explorer (ask) and RAG indexing now live in a separate Python
// service (see ai-service/README.md) — everything else on this page still
// talks to the Java backend at API_BASE above.
const AI_SERVICE_BASE = import.meta.env.VITE_AI_SERVICE_BASE_URL || 'http://localhost:8001';

/**
 * Sends the completed analysis result to the backend for storage + RAG indexing.
 * @param {string} repositoryId - the same UUID already used as the IndexedDB snapshot key
 * @param {object} analysisResult - orchestrator.js's analyzeRepository() output
 */
/** Fetches the Recent Repositories list for the Upload Page. */
export async function listRepositories() {
    const res = await fetch(`${API_BASE}/api/repository/list`);
    if (!res.ok) throw new Error(`Failed to load recent repositories (${res.status})`);
    return res.json();
}

/**
 * Reconstructs a full analysis result for a previously-ingested repository
 * (no `fileContents` — the backend never stores whole-file source; see
 * PROJECT_DOCUMENTATION.md section 8). Returns null if not found (e.g. it
 * only ever existed as a local IndexedDB snapshot whose ingest had failed).
 */
export async function getRepositoryDetail(repositoryId) {
    const res = await fetch(`${API_BASE}/api/repository/${repositoryId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load repository (${res.status})`);
    return res.json();
}

/** Deletes a repository and everything derived from it (cascades server-side). */
export async function deleteRepository(repositoryId) {
    const res = await fetch(`${API_BASE}/api/repository/${repositoryId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete repository (${res.status})`);
    }
}

export async function ingestAnalysis(repositoryId, analysisResult) {
    const res = await fetch(`${API_BASE}/api/repository/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryId, ...analysisResult }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Backend ingest failed (${res.status})`);
    }

    return res.json();
}

/**
 * Asks the AI Explorer backend a question, optionally scoped to a Focused
 * Mode node and/or the file currently open in the editor (Task 6: the open
 * file automatically becomes primary context — see
 * PROJECT_DOCUMENTATION.md section 11 / DEVELOPMENT_PROGRESS.md).
 * @param {string} repositoryId
 * @param {string} question
 * @param {string} [focusedNode]
 * @param {string} [openFilePath]
 */
/**
 * @param {string} repositoryId
 * @param {string} question
 * @param {string|null} focusedNode
 * @param {string|null} openFilePath
 * @param {string} [persona] - UI presentation persona id ('normal' | 'detective' |
 *   'missionControl', see pages/aiExplorerPersonas.js). Sent as an optional field;
 *   today's backend doesn't read it, so it has no effect on the returned answer's
 *   wording yet — the persona only changes labels/copy on the frontend. Included
 *   here so a future backend change can use it without another frontend change.
 */
export async function askAi(repositoryId, question, focusedNode, openFilePath, persona) {
    const res = await fetch(`${AI_SERVICE_BASE}/api/ai/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repositoryId, question,
            focusedNode: focusedNode || null,
            openFilePath: openFilePath || null,
            persona: persona || null,
        }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `AI request failed (${res.status})`);
    }

    return res.json();
}

/**
 * Real LLM-backed unit tests for one function (replaces the frontend's
 * local buildMockTests() preview when the AI service + LLM key are
 * configured). Stateless — sends the function's source directly, no
 * repositoryId needed. Throws on any failure (network, 503 missing API
 * key, 502 unparseable model output, 500 other) — callers should catch
 * this and fall back to the local mock so the page still works offline.
 * @param {string} functionName
 * @param {string} filePath
 * @param {string} code
 */
export async function generateTestsAi(functionName, filePath, code) {
    const res = await fetch(`${AI_SERVICE_BASE}/api/code/generate-tests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ functionName, filePath, code: code || '' }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Test generation failed (${res.status})`);
    }

    return res.json(); // { testCode, coverageEstimate, notes }
}

/**
 * Real LLM-backed legacy-pattern review for one file (replaces the
 * frontend's local buildMockMigration() preview). Same stateless shape and
 * fallback contract as generateTestsAi() above.
 * @param {string} filePath
 * @param {string} code
 */
export async function suggestMigrationAi(filePath, code) {
    const res = await fetch(`${AI_SERVICE_BASE}/api/code/suggest-migration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, code: code || '' }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Migration suggestion failed (${res.status})`);
    }

    return res.json(); // { hunks: [{ before, after, category, severity, explanation }] }
}
