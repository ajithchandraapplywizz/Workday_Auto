import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function Header({ activeTab, onTabChange, operatorView, onOperatorViewChange }) {
  const { user, switchRole, logout, date, setDate, timeframe, setTimeframe } = useAuth();

  const getSubTitle = () => {
    switch (user?.role) {
      case 'dev': return 'APPLYWIZZ / EXTERNALS';
      case 'admin': return 'APPLYWIZZ / OPS OPS';
      case 'manager': return 'APPLYWIZZ / CONTROL ROOM';
      case 'operator':
      case 'ca':
        return 'APPLYWIZZ';
      default: return 'APPLYWIZZ';
    }
  };

  const getMainTitle = () => {
    switch (user?.role) {
      case 'dev': return 'Developer dashboard';
      case 'admin': return 'Admin dashboard';
      case 'manager': return 'Manager dashboard';
      case 'operator':
      case 'ca':
        return '';
      default: return 'Workday Dashboard';
    }
  };

  return (
    <header className="video-header">
      <div className="header-top-row">
        {/* Brand & Title */}
        <div className="header-brand-block">
          <div className="header-logo-container">
            <img src="/logo.png" alt="ApplyWizz" className="header-logo-icon" />
          </div>
          <div className="header-title-container">
            <span className="header-sub-label">{getSubTitle()}</span>
            {(user?.role === 'operator' || user?.role === 'ca') ? (
              <div className="operator-nav-pills">
                <button
                  type="button"
                  className={`operator-pill-btn ${operatorView === 'dashboard' ? 'active' : ''}`}
                  onClick={() => onOperatorViewChange('dashboard')}
                >
                  Candidate Queue
                </button>
                <button
                  type="button"
                  className={`operator-pill-btn ${operatorView === 'stats' ? 'active' : ''}`}
                  onClick={() => onOperatorViewChange('stats')}
                >
                  Stats
                </button>
              </div>
            ) : (
              <h1 className="header-main-title">{getMainTitle()}</h1>
            )}
          </div>
        </div>

        {/* Global Controls: Role Switcher (Developer Only), Date, Timeframe, Refresh, User */}
        <div className="header-controls-block">
          {/* ONLY Developer (Ajith) can switch roles across all 4 dashboards */}
          {(user?.baseRole === 'dev' || user?.role === 'dev' || user?.email === 'ajithchandranimmala@applywizz.ai') && (
            <div className="role-pill-group" title="Developer Master Override">
              {[
                { id: 'dev', label: 'Dev' },
                { id: 'admin', label: 'Admin' },
                { id: 'manager', label: 'Manager' },
                { id: 'operator', label: 'Operator' },
              ].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`role-pill-item ${user?.role === r.id ? 'active' : ''}`}
                  onClick={() => switchRole(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          {/* Date Picker */}
          <div className="control-date-box">
            <span className="control-label-micro">DATE</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="header-date-input"
            />
          </div>

          {/* Timeframe Stats: Day, Week, Month */}
          <div className="control-stats-box">
            <span className="control-label-micro">STATS</span>
            <div className="stats-pill-group">
              {['day', 'week', 'month'].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`stats-pill-item ${timeframe === t ? 'active' : ''}`}
                  onClick={() => setTimeframe(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            className="header-refresh-btn"
            onClick={() => window.location.reload()}
          >
            Refresh
          </button>

          {/* User & Sign Out */}
          <div className="header-user-badge">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.2 }}>
              <span className="header-user-email" style={{ fontWeight: 'bold' }}>
                {user?.name || user?.email?.split('@')[0]}
              </span>
              <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                {user?.email} • <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>{user?.role?.toUpperCase()}</span>
              </span>
            </div>
            <button
              type="button"
              className="header-signout-btn"
              onClick={logout}
              title="Sign in with Microsoft Authenticator"
            >
              Switch / Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
