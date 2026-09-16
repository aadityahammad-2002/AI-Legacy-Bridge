/**
 * session/session.js
 *
 * Client-side session persistence, per PROJECT_DOCUMENTATION.md section 9-10:
 *   - localStorage: small pointers (`activeRepositoryId`, `currentWorkspace`)
 *   - IndexedDB: the full Live Analysis Model snapshot (too large for localStorage),
 *     so Visualization Explorer can reload instantly after a refresh without
 *     re-running the Analysis Engine or re-fetching the repository.
 *
 * This is the single source of truth for "what repo/workspace is the user
 * currently in" on the client. The backend is never consulted to answer that
 * question — it only gets `repositoryId` on each AI Explorer request.
 */

const DB_NAME = 'legacy-bridge';
const DB_VERSION = 1;
const STORE_NAME = 'analysisSnapshots';

const LS_KEYS = {
    activeRepositoryId: 'legacybridge:activeRepositoryId',
    currentWorkspace: 'legacybridge:currentWorkspace', // 'visualization' | 'ai-explorer'
};

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'repositoryId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Saves the full analysis result (our backend ingest payload) as the Live Analysis Model snapshot. */
export async function saveAnalysisSnapshot(repositoryId, analysisResult) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ repositoryId, analysisResult, savedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** Loads a previously-saved Live Analysis Model snapshot, or null if none exists. */
export async function loadAnalysisSnapshot(repositoryId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(repositoryId);
        req.onsuccess = () => resolve(req.result ? req.result.analysisResult : null);
        req.onerror = () => reject(req.error);
    });
}

export async function clearAnalysisSnapshot(repositoryId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(repositoryId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// --- localStorage pointers ---

export function setActiveSession(repositoryId, workspace = 'visualization') {
    localStorage.setItem(LS_KEYS.activeRepositoryId, repositoryId);
    localStorage.setItem(LS_KEYS.currentWorkspace, workspace);
}

export function getActiveRepositoryId() {
    return localStorage.getItem(LS_KEYS.activeRepositoryId);
}

export function getCurrentWorkspace() {
    return localStorage.getItem(LS_KEYS.currentWorkspace) || 'visualization';
}

export function setCurrentWorkspace(workspace) {
    localStorage.setItem(LS_KEYS.currentWorkspace, workspace);
}

/**
 * Exit Repository: clears client-side session state only. Stored repository
 * data in PostgreSQL is intentionally left untouched (see PROJECT_DOCUMENTATION.md
 * section 10 — kept for future multi-repository support).
 */
export async function exitRepository() {
    const repositoryId = getActiveRepositoryId();
    if (repositoryId) await clearAnalysisSnapshot(repositoryId);
    localStorage.removeItem(LS_KEYS.activeRepositoryId);
    localStorage.removeItem(LS_KEYS.currentWorkspace);
}
