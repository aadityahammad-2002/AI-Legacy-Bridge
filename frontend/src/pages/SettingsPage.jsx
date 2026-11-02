import { useState } from 'react';
import { User, Users, Plug, Trash2, Plus, ArrowLeft, Check, BarChart2, AlertTriangle } from 'lucide-react';
import TopNavBar from '../components/TopNavBar.jsx';
import { listRepositories } from '../api/backend.js';
import {
    getProfile,
    saveProfile,
    getTeamMembers,
    addTeamMember,
    updateTeamMemberRole,
    removeTeamMember,
} from '../session/settings.js';
import './SettingsPage.css';

const ROLES = ['Admin', 'Member', 'Read-only'];
const SECTIONS = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'team', label: 'Local team list', icon: Users },
    { id: 'dashboard', label: 'Team overview', icon: BarChart2 },
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
                <p>Local display preferences only. This is not an authenticated account profile.</p>
            </div>

            <div className="settings-field">
                <label>Name</label>
                <input type="text" value={profile.name} onChange={update('name')} placeholder="Your name" />
            </div>

            <div className="settings-field">
                <label>Email</label>
                <input type="email" value={profile.email} onChange={update('email')} placeholder="you@company.com" />
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
                <h2>Local team list</h2>
                <p>Browser-only contact list. Adding members or changing roles here does not invite anyone, change repository permissions, or enforce access control.</p>
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
                    Add local entry
                </button>
            </div>
            {error && <p className="settings-field__error">{error}</p>}

            {members.length === 0 ? (
                <p className="settings-empty">No local team entries yet. This list does not share the workspace.</p>
            ) : (
                <table className="settings-team-table">
                    <thead>
                        <tr>
                            <th>Email</th>
                            <th>Local role note</th>
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
    return (
        <div className="settings-card settings-card--wide">
            <div className="settings-card__header">
                <h2>Team dashboard</h2>
                <p>Configured local team entries — not onboarding telemetry.</p>
            </div>
            <div className="dash-metrics">
                <div className="dash-metric-card">
                    <span className="dash-metric-card__label">Team entries in this browser</span>
                    <span className="dash-metric-card__value">{members.length}</span>
                </div>
                <div className="dash-metric-card">
                    <span className="dash-metric-card__label">Measured onboarding duration</span>
                    <span className="dash-metric-card__value">Unavailable</span>
                </div>
            </div>
            {members.length === 0 ? (
                <p className="settings-empty">No team entries have been configured in this browser.</p>
            ) : (
                <div className="dash-progress-list">
                    <span className="dash-chart__label">Configured team members</span>
                    {members.map((member) => (
                        <div key={member.id} className="dash-progress-row">
                            <span className="dash-progress-row__name">{member.email}</span>
                            <span className="dash-progress-row__pct">{member.role || 'Member'}</span>
                        </div>
                    ))}
                </div>
            )}
            <p className="settings-empty">Autonomy %, before/after onboarding time and usage analytics are not collected by this frontend. No estimates or fabricated progress are shown.</p>
        </div>
    );
}

function ConnectionsSection() {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const check = async () => {
        setBusy(true);
        const started = performance.now();
        try {
            const data = await listRepositories();
            setState({ ok: true, ms: Math.round(performance.now() - started), count: Array.isArray(data) ? data.length : null });
        } catch (error) {
            setState({ ok: false, ms: Math.round(performance.now() - started), error: error?.message || 'Connection unavailable' });
        } finally { setBusy(false); }
    };
    return (
        <div className="settings-card">
            <div className="settings-card__header">
                <h2>Configured services</h2>
                <p>Service addresses come from frontend environment configuration, not browser-stored keys.</p>
            </div>
            <div className="settings-field"><label>Repository backend</label>
                <code>{import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'}</code>
            </div>
            <div className="settings-field"><label>AI service</label>
                <code>{import.meta.env.VITE_AI_SERVICE_BASE_URL || 'http://localhost:8001'}</code>
            </div>
            <p className="settings-hint">Configure provider API keys and database credentials on the appropriate backend service. The frontend never validates or stores those secrets. AI inference availability is not implied by a repository-backend response.</p>
            <div className="settings-actions"><button className="settings-btn settings-btn--primary" onClick={check} disabled={busy}>{busy ? 'Checking…' : 'Check repository backend'}</button></div>
            {state && <p role="status" className={state.ok ? 'settings-hint' : 'settings-field__error'}>
                {state.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
                {state.ok ? ` Backend responded in ${state.ms} ms${state.count == null ? '' : ` (${state.count} repository records)`}` : ` ${state.error}`}
            </p>}
        </div>
    );
}
