import { useState } from 'react';
import { GitBranch, Boxes, MessageSquareCode, LogOut, Settings, User, FlaskConical, GitCompare } from 'lucide-react';
import { getProfile } from '../session/settings.js';
import './TopNavBar.css';

/**
 * Common nav bar shown in both workspaces (see PROJECT_DOCUMENTATION.md
 * section 9). Switching tabs never re-runs analysis — it's just a view
 * change over the same Live Analysis Model / stored repository data.
 *
 * onNavigate also accepts 'settings' as a target (handled by App.jsx's
 * state machine) so this same nav bar can open the Settings screen from
 * any workspace.
 */
export default function TopNavBar({ activeWorkspace, onNavigate, onExitRepository }) {
    const [confirmingExit, setConfirmingExit] = useState(false);
    const profile = getProfile();
    const initials = (profile.name || profile.email || 'A')
        .trim()
        .split(/\s+/)
        .map((s) => s[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

    return (
        <nav className="top-nav">
            <div className="top-nav__brand">
                <GitBranch size={15} strokeWidth={2} />
                AI Legacy Bridge
            </div>

            <div className="top-nav__tabs">
                <button
                    className={`top-nav__tab${activeWorkspace === 'visualization' ? ' top-nav__tab--active' : ''}`}
                    onClick={() => onNavigate('visualization')}
                >
                    <Boxes size={14} strokeWidth={1.8} />
                    Visualization Explorer
                </button>
                <button
                    className={`top-nav__tab${activeWorkspace === 'ai-explorer' ? ' top-nav__tab--active' : ''}`}
                    onClick={() => onNavigate('ai-explorer')}
                >
                    <MessageSquareCode size={14} strokeWidth={1.8} />
                    AI Explorer
                </button>
                <button
                    className={`top-nav__tab${activeWorkspace === 'tests' ? ' top-nav__tab--active' : ''}`}
                    onClick={() => onNavigate('tests')}
                >
                    <FlaskConical size={14} strokeWidth={1.8} />
                    Tests
                </button>
                <button
                    className={`top-nav__tab${activeWorkspace === 'migrate' ? ' top-nav__tab--active' : ''}`}
                    onClick={() => onNavigate('migrate')}
                >
                    <GitCompare size={14} strokeWidth={1.8} />
                    Migrate
                </button>
            </div>

            <div className="top-nav__right">
                <button
                    className={`top-nav__tab${activeWorkspace === 'settings' ? ' top-nav__tab--active' : ''}`}
                    onClick={() => onNavigate('settings')}
                    aria-label="Settings"
                >
                    <Settings size={14} strokeWidth={1.8} />
                    Settings
                </button>
                <button className="top-nav__account" onClick={() => onNavigate('settings')} aria-label="Account">
                    {initials ? <span className="top-nav__avatar">{initials}</span> : <User size={16} strokeWidth={1.8} />}
                </button>
            </div>

            <div className="top-nav__exit">
                {!confirmingExit ? (
                    <button className="top-nav__exit-btn" onClick={() => setConfirmingExit(true)}>
                        <LogOut size={14} strokeWidth={1.8} />
                        Exit Repository
                    </button>
                ) : (
                    <div className="top-nav__exit-confirm">
                        <span>Exit this repository?</span>
                        <button className="top-nav__exit-confirm-yes" onClick={onExitRepository}>
                            Yes, exit
                        </button>
                        <button className="top-nav__exit-confirm-no" onClick={() => setConfirmingExit(false)}>
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </nav>
    );
}
