import React from 'react';
import { useAuth } from '../context/AuthContext';
import { ShieldCheck, LogOut, RefreshCw, Cpu, Layers, Users, BarChart3, Terminal } from 'lucide-react';

export default function Navbar({ onOpenAuth }) {
  const { user, switchRole, logout } = useAuth();

  const navRoles = [
    { id: 'ca', label: 'Workday Auto-Apply', icon: Layers, desc: 'Candidate & Live Apply' },
    { id: 'admin', label: 'Executive Admin', icon: BarChart3, desc: 'Executive Overview' },
    { id: 'ops', label: 'Ops Manager', icon: Users, desc: 'Workload & Teams' },
    { id: 'dev', label: 'Developer & APIs', icon: Terminal, desc: 'APIs & Schema' },
  ];

  return (
    <header className="top-nav">
      <div className="nav-container">
        {/* Brand identity */}
        <div className="nav-brand" onClick={() => onOpenAuth()}>
          <div className="nav-logo-box">
            <img src="/logo.png" alt="ApplyWizz" className="nav-logo" />
          </div>
          <div className="nav-brand-text">
            <span className="brand-title">APPLYWIZZ</span>
            <span className="brand-badge">WORKDAY AUTO-HUB</span>
          </div>
        </div>

        {/* Dynamic 4-Dashboard Switcher Tabs */}
        <nav className="nav-role-tabs">
          {navRoles.map((item) => {
            const Icon = item.icon;
            const isActive = user?.role === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-tab-btn ${isActive ? 'active' : ''}`}
                onClick={() => switchRole(item.id)}
              >
                <Icon size={16} className="nav-tab-icon" />
                <span className="nav-tab-label">{item.label}</span>
                {isActive && <span className="nav-tab-indicator" />}
              </button>
            );
          })}
        </nav>

        {/* Right side: System health + User Profile */}
        <div className="nav-actions">
          {/* Live Pipeline Status */}
          <div className="live-status-pill">
            <span className="pulse-dot" />
            <span className="status-text">SYSTEM LIVE</span>
          </div>

          {/* Microsoft Authenticator Profile Card */}
          {user ? (
            <div className="user-profile-widget">
              <div className="user-shield-icon" title="Secured with Microsoft Authenticator">
                <ShieldCheck size={18} />
              </div>
              <div className="user-info">
                <span className="user-name">{user.name}</span>
                <span className="user-role-tag">{user.role.toUpperCase()}</span>
              </div>
              <button
                type="button"
                className="user-change-btn"
                onClick={onOpenAuth}
                title="Switch Microsoft Account or Role"
              >
                Switch
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="sign-in-nav-btn"
              onClick={onOpenAuth}
            >
              Sign In with Authenticator
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
