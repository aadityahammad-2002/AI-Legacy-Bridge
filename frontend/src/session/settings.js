/**
 * session/settings.js
 *
 * Client-side persistence for the Settings screen (Account/Profile, Team
 * access, Connections). Follows the same localStorage convention as
 * session.js (`legacybridge:` key prefix).
 *
 * IMPORTANT: this is a frontend-only stopgap. There is no backend endpoint
 * yet for account/team/connection data, so everything here lives in the
 * browser's localStorage on this one machine — it is NOT shared across
 * devices or team members, and the LLM API key is stored in plaintext in
 * localStorage (not encrypted at rest). Once the backend adds real
 * auth + a secrets table, this module should be replaced with API calls
 * and the key should never round-trip back to the browser after save.
 */

const LS_KEYS = {
    profile: 'legacybridge:profile',
    team: 'legacybridge:team',
    connections: 'legacybridge:connections',
};

const DEFAULT_PROFILE = {
    name: '',
    email: '',
    role: 'Admin',
};

const DEFAULT_TEAM = [];

const DEFAULT_CONNECTIONS = {
    llmApiKey: '',
    llmProvider: 'groq',
    dbConnectionString: '',
};

function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

// --- Profile ---
export function getProfile() {
    return { ...DEFAULT_PROFILE, ...readJson(LS_KEYS.profile, {}) };
}

export function saveProfile(profile) {
    writeJson(LS_KEYS.profile, profile);
}

// --- Team ---
export function getTeamMembers() {
    return readJson(LS_KEYS.team, DEFAULT_TEAM);
}

export function saveTeamMembers(members) {
    writeJson(LS_KEYS.team, members);
}

export function addTeamMember(member) {
    const members = getTeamMembers();
    const next = [...members, { id: crypto.randomUUID(), ...member }];
    saveTeamMembers(next);
    return next;
}

export function updateTeamMemberRole(id, role) {
    const next = getTeamMembers().map((m) => (m.id === id ? { ...m, role } : m));
    saveTeamMembers(next);
    return next;
}

export function removeTeamMember(id) {
    const next = getTeamMembers().filter((m) => m.id !== id);
    saveTeamMembers(next);
    return next;
}

// --- Connections (LLM key, DB connection) ---
export function getConnections() {
    return { ...DEFAULT_CONNECTIONS, ...readJson(LS_KEYS.connections, {}) };
}

export function saveConnections(connections) {
    writeJson(LS_KEYS.connections, connections);
}

// --- Danger zone ---
export function clearAllSettings() {
    localStorage.removeItem(LS_KEYS.profile);
    localStorage.removeItem(LS_KEYS.team);
    localStorage.removeItem(LS_KEYS.connections);
}
