/**
 * session/settings.js
 *
 * Client-side persistence for the Settings screen (Account/Profile, Team
 * access, Connections). Follows the same localStorage convention as
 * session.js (`legacybridge:` key prefix).
 *
 * IMPORTANT: profile and team entries are local browser notes, not
 * authenticated accounts or permission settings. Service credentials
 * must be configured server-side and are not collected on the UI.
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
