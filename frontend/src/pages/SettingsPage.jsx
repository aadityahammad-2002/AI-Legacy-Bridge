import { useState, useEffect } from 'react';
import { User, Users, Plug, Eye, EyeOff, Trash2, Plus, ArrowLeft, Check, BarChart2 } from 'lucide-react';
import TopNavBar from '../components/TopNavBar.jsx';
import {
    getProfile,
    saveProfile,
    getTeamMembers,
    addTeamMember,
    updateTeamMemberRole,
    removeTeamMember,
    getConnections,
    saveConnections,
    clearAllSettings,
} from '../session/settings.js';
import './SettingsPage.css';

const ROLES = ['Admin', 'Member', 'Read-only'];
const SECTIONS = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'team', label: 'Team access', icon: Users },
    { id: 'dashboard', label: 'Team dashboard', icon: BarChart2 },
    { id: 'connections', label: 'Connections', icon: Plug },
];

/**
 * Settings screen. Frontend-only for now (see session/settings.js) —
 * everything persists to localStorage, not the backend. Reachable from
 * TopNavBar's new "Settings" tab.
 */
export default function SettingsPage({ activeWorkspace, onNavigate, onExitRepository, onBack }) {
    const [section, setSection] = useState('profile');

    return (
        <div className="settings-page">
            <TopNavBar activeWorkspace={activeWorkspace} onNavigate={onNavigate} onExitRepository={onExitRepository} />

            <div className="settings-layout">
                <aside className="settings-sidebar">
                    <button className="settings-back" onClick={onBack}>
                        <ArrowLeft size={14} strokeWidth={2} />
                        Back to workspace
                    </button>
                    <nav className="settings-nav">
                        {SECTIONS.map(({ id, label, icon: Icon }) => (
                            <button
                                key={id}
                                className={`settings-nav__item${section === id ? ' settings-nav__item--active' : ''}`}
                                onClick={() => setSection(id)}
                            >
                                <Icon size={15} strokeWidth={1.8} />
                                {label}
                            </button>
                        ))}
                    </nav>
                </aside>

                <main className="settings-content">
                    {section === 'profile' && <ProfileSection />}
                    {section === 'team' && <TeamSection />}
                    {section === 'dashboard' && <TeamDashboardSection />}
                    {section === 'connections' && <ConnectionsSection />}
                </main>
            </div>
        </div>
    );
}

function SavedBadge({ show }) {
    if (!show) return null;
    return (
        <span className="settings-saved">
            <Check size={12} strokeWidth={2.5} />
            Saved
        </span>
    );
}

function useSavedFlash() {
    const [saved, setSaved] = useState(false);
    const flash = () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
    };
    return [saved, flash];
}

function ProfileSection() {
    const [profile, setProfile] = useState(getProfile());
    const [saved, flash] = useSavedFlash();

    const update = (field) => (e) => setProfile((p) => ({ ...p, [field]: e.target.value }));

    const handleSave = () => {
        saveProfile(profile);
        flash();
    };

    return (
        <div className="settings-card">
            <div className="settings-card__header">
                <h2>Profile</h2>
                <p>Your account details for this workspace.</p>
            </div>

            <div className="settings-field">
                <label>Name</label>
                <input type="text" value={profile.name} onChange={update('name')} placeholder="Your name" />
            </div>

            <div className="settings-field">
                <label>Email</label>
                <input type="email" value={profile.email} onChange={update('email')} placeholder="you@company.com" />
            </div>

            <div className="settings-field">
                <label>Role</label>
                <select value={profile.role} onChange={update('role')}>
                    {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                    ))}
                </select>
            </div>

            <div className="settings-actions">
                <button className="settings-btn settings-btn--primary" onClick={handleSave}>Save changes</button>
                <SavedBadge show={saved} />
            </div>
        </div>
    );
}

function TeamSection() {
    const [members, setMembers] = useState(getTeamMembers());
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');

    const handleAdd = () => {
        const trimmed = email.trim();
        if (!trimmed) {
            setError('Enter an email first');
            return;
        }
        if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
            setError('Enter a valid email address');
            return;
        }
        if (members.some((m) => m.email.toLowerCase() === trimmed.toLowerCase())) {
            setError('That email is already on the team');
            return;
        }
        const next = addTeamMember({ email: trimmed, role: 'Member' });
        setMembers(next);
        setEmail('');
        setError('');
    };

    const handleRoleChange = (id, role) => {
        setMembers(updateTeamMemberRole(id, role));
    };

    const handleRemove = (id) => {
        setMembers(removeTeamMember(id));
    };

    return (
        <div className="settings-card">
            <div className="settings-card__header">
                <h2>Team access</h2>
                <p>Manage who can open this workspace and what they can do.</p>
            </div>

            <div className="settings-team-add">
                <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); if (error) setError(''); }}
                    placeholder="name@company.com"
                />
                <button className="settings-btn settings-btn--primary" onClick={handleAdd}>
                    <Plus size={14} strokeWidth={2} />
                    Add member
                </button>
            </div>
            {error && <p className="settings-field__error">{error}</p>}

            {members.length === 0 ? (
                <p className="settings-empty">No team members yet. Add someone above to share this workspace.</p>
            ) : (
                <table className="settings-team-table">
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Role</th>
                            <th aria-label="Remove"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {members.map((m) => (
                            <tr key={m.id}>
                                <td>{m.email}</td>
                                <td>
                                    <select value={m.role} onChange={(e) => handleRoleChange(m.id, e.target.value)}>
                                        {ROLES.map((r) => (
                                            <option key={r} value={r}>{r}</option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <button className="settings-icon-btn" onClick={() => handleRemove(m.id)} aria-label={`Remove ${m.email}`}>
                                        <Trash2 size={14} strokeWidth={1.8} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function TeamDashboardSection() {
    const members = getTeamMembers();

    // No telemetry backend exists yet to measure real onboarding time or
    // autonomy — these are deterministic, per-member mock values (stable
    // across reloads, not random) so the screen is demoable without
    // pretending to be live data. Swap for a real metrics API later.
    const withAutonomy = members.map((m) => ({
        ...m,
        autonomy: 20 + (Math.abs(hashCode(m.email)) % 76), // 20-95%, stable per email
    }));
    const fullAutonomyCount = withAutonomy.filter((m) => m.autonomy >= 90).length;
    const avgDays = members.length
        ? Math.max(14, 60 - Math.round((withAutonomy.reduce((s, m) => s + m.autonomy, 0) / withAutonomy.length) / 3))
        : 27;

    return (
        <div className="settings-card settings-card--wide">
            <div className="settings-card__header">
                <h2>Team dashboard</h2>
                <p>
                    Onboarding progress across your team.
                    <span className="settings-mock-badge">Preview — based on mock autonomy data, not real telemetry yet</span>
                </p>
            </div>

            {members.length === 0 ? (
                <p className="settings-empty">Add team members in "Team access" to see their onboarding progress here.</p>
            ) : (
                <>
                    <div className="dash-metrics">
                        <div className="dash-metric-card">
                            <span className="dash-metric-card__label">Average onboarding time</span>
                            <span className="dash-metric-card__value">{avgDays} days</span>
                        </div>
                        <div className="dash-metric-card">
                            <span className="dash-metric-card__label">Developers at full autonomy</span>
                            <span className="dash-metric-card__value">{fullAutonomyCount} of {members.length}</span>
                        </div>
                    </div>

                    <div className="dash-chart">
                        <span className="dash-chart__label">Onboarding time: before vs after tool</span>
                        <div className="dash-chart__bars">
                            <div className="dash-bar">
                                <div className="dash-bar__fill dash-bar__fill--before" style={{ height: '100%' }} />
                                <span className="dash-bar__value">60 days</span>
                                <span className="dash-bar__caption">Before</span>
                            </div>
                            <div className="dash-bar">
                                <div className="dash-bar__fill dash-bar__fill--after" style={{ height: `${Math.round((avgDays / 60) * 100)}%` }} />
                                <span className="dash-bar__value">{avgDays} days</span>
                                <span className="dash-bar__caption">After</span>
                            </div>
                        </div>
                    </div>

                    <div className="dash-progress-list">
                        <span className="dash-chart__label">Team member autonomy progress</span>
                        {withAutonomy.map((m) => (
                            <div key={m.id} className="dash-progress-row">
                                <span className="dash-progress-row__name">{m.email}</span>
                                <div className="dash-progress-row__bar">
                                    <div style={{ width: `${m.autonomy}%` }} />
                                </div>
                                <span className="dash-progress-row__pct">{m.autonomy}%</span>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
    return h;
}

function ConnectionsSection() {
    const [connections, setConnections] = useState(getConnections());
    const [showKey, setShowKey] = useState(false);
    const [saved, flash] = useSavedFlash();
    const [confirmingClear, setConfirmingClear] = useState(false);

    const update = (field) => (e) => setConnections((c) => ({ ...c, [field]: e.target.value }));

    const handleSave = () => {
        saveConnections(connections);
        flash();
    };

    const handleClearAll = () => {
        clearAllSettings();
        setConnections(getConnections());
        setConfirmingClear(false);
    };

    return (
        <div className="settings-card">
            <div className="settings-card__header">
                <h2>Connections</h2>
                <p>Your LLM provider key and database connection, used to run analysis locally.</p>
            </div>

            <div className="settings-field">
                <label>LLM API key</label>
                <div className="settings-field__with-action">
                    <input
                        type={showKey ? 'text' : 'password'}
                        value={connections.llmApiKey}
                        onChange={update('llmApiKey')}
                        placeholder="Paste your provider API key"
                    />
                    <button className="settings-icon-btn" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key'}>
                        {showKey ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
                    </button>
                </div>
                <p className="settings-hint">Stored only in this browser's local storage — never sent anywhere except your configured LLM provider.</p>
            </div>

            <div className="settings-field">
                <label>Database connection</label>
                <input
                    type="text"
                    value={connections.dbConnectionString}
                    onChange={update('dbConnectionString')}
                    placeholder="postgres://user:password@host:5432/dbname"
                />
            </div>

            <div className="settings-actions">
                <button className="settings-btn settings-btn--primary" onClick={handleSave}>Save and validate</button>
                <SavedBadge show={saved} />
            </div>

            <div className="settings-danger">
                <div>
                    <h3>Delete all analysis data</h3>
                    <p>Removes all processed codebase history and generated charts. This action is irreversible.</p>
                </div>
                {!confirmingClear ? (
                    <button className="settings-btn settings-btn--danger" onClick={() => setConfirmingClear(true)}>Delete</button>
                ) : (
                    <div className="settings-danger__confirm">
                        <button className="settings-btn settings-btn--danger" onClick={handleClearAll}>Yes, delete</button>
                        <button className="settings-btn" onClick={() => setConfirmingClear(false)}>Cancel</button>
                    </div>
                )}
            </div>
        </div>
    );
}
