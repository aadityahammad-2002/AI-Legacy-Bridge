/**
 * session/testLock.js
 *
 * Lightweight bridge between Tests and Migrate: when a user accepts a
 * generated test for a function in Tests, we record that file as
 * "test-locked" (has at least one accepted behavior-check). Migrate reads
 * this before suggesting changes to a file, so users are nudged to lock in
 * current behavior with tests before rewriting legacy code — without any
 * backend round-trip or cross-page state lifting.
 *
 * Storage shape: { [filePath]: { functions: string[], lockedAt: number } }
 */

const LS_KEY = 'legacybridge:testLock';

function readMap() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function writeMap(map) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(map));
    } catch {
        // localStorage unavailable/full — test-lock is a nice-to-have nudge, fail silently.
    }
}

/** Call when a user accepts a generated test for `functionName` in `filePath`. */
export function markFileTestLocked(filePath, functionName) {
    if (!filePath) return;
    const map = readMap();
    const existing = map[filePath] || { functions: [], lockedAt: Date.now() };
    if (functionName && !existing.functions.includes(functionName)) {
        existing.functions = [...existing.functions, functionName];
    }
    existing.lockedAt = Date.now();
    map[filePath] = existing;
    writeMap(map);
}

/** Returns the lock record for a file, or null if no tests have been accepted for it yet. */
export function getFileTestLock(filePath) {
    if (!filePath) return null;
    return readMap()[filePath] || null;
}
