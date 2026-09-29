import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchManagers,
  fetchManagerTeamWorkHistory,
  fetchApplicationsDynamic,
  syncGlobalCompanyData,
} from '../services/api';
import CAClientDetailsModal from '../components/CAClientDetailsModal';
import OperatorDetailsPage from './OperatorDetailsPage';

export default function ManagerDashboard() {
  const { user, date, timeframe, setTimeframe } = useAuth();

  const [activeTab, setActiveTab] = useState('Home');
  const [selectedCA, setSelectedCA] = useState('All');
  const [dateRange, setDateRange] = useState(timeframe || 'Today');
  const [opsMode, setOpsMode] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState(null);
  const [selectedOperatorForModal, setSelectedOperatorForModal] = useState(null);
  const [selectedOperatorDetails, setSelectedOperatorDetails] = useState(null);

  // Managers roster
  const [managers, setManagers] = useState([]);
  const [activeManagerId, setActiveManagerId] = useState(
    user?.email?.toLowerCase().includes('balaji')
      ? '9dc9376e-fbc5-440b-932f-38da10b89a70'
      : 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744'
  );

  // Synchronize activeManagerId if user email changes
  useEffect(() => {
    if (user?.email?.toLowerCase().includes('balaji')) {
      setActiveManagerId('9dc9376e-fbc5-440b-932f-38da10b89a70');
    } else if (user?.email?.toLowerCase().includes('ramakrishna')) {
      setActiveManagerId('bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744');
    }
  }, [user?.email]);

  // Real dynamic states
  const [operators, setOperators] = useState([]);
  const [teamClients, setTeamClients] = useState([]);
  const [applications, setApplications] = useState([]);
  const [activeWorkDate, setActiveWorkDate] = useState(date);
  const [isFallbackDate, setIsFallbackDate] = useState(false);
  const [loading, setLoading] = useState(false);

  const tabs = ['Home', 'Operators', 'Activity', 'Reports', 'Guide'];

  // Load managers list once
  useEffect(() => {
    async function loadManagers() {
      const res = await fetchManagers();
      if (res.success && res.managers?.length) {
        setManagers(res.managers);
      }
    }
    loadManagers();
  }, []);

  // Sync dateRange button click with global timeframe
  const handleDateRangeChange = (range) => {
    setDateRange(range);
    if (range.toLowerCase() === 'today' || range.toLowerCase() === 'day') setTimeframe('day');
    else if (range.toLowerCase() === 'week') setTimeframe('week');
    else if (range.toLowerCase() === 'month') setTimeframe('month');
  };

  // Strictly pre-scoped query to manager_id (Zero data duplication between Balaji & Ramakrishna)
  const loadManagerData = React.useCallback(async () => {
    setLoading(true);
    setSelectedCA('All');
    try {
      const [teamRes, appsRes] = await Promise.all([
        fetchManagerTeamWorkHistory({
          managerId: activeManagerId,
          dateStr: date,
        }),
        fetchApplicationsDynamic({
          managerId: activeManagerId,
          dateStr: date,
          timeframe,
          limit: 200,
        }),
      ]);

      if (teamRes.success) {
        setOperators(teamRes.operators || []);
        setTeamClients(teamRes.clients || []);
        setActiveWorkDate(teamRes.activeDate || date);
        setIsFallbackDate(Boolean(teamRes.isFallback));
      }

      if (appsRes.success) {
        setApplications(appsRes.applications || []);
      }
    } catch (err) {
      console.error('Error loading manager data:', err);
    } finally {
      setLoading(false);
    }
  }, [activeManagerId, date, timeframe]);

  useEffect(() => {
    loadManagerData();
  }, [loadManagerData]);

  // Sync team data directly from CA portal with fallback
  const handleTeamSync = async () => {
    setIsSyncing(true);
    setSyncToast(null);
    try {
      const res = await syncGlobalCompanyData({ dateStr: date });
      if (res.success) {
        setSyncToast({
          type: 'success',
          text: `✓ ${res.message || 'Team allocations and work history refreshed successfully.'}`,
        });
        await loadManagerData();
      } else {
        setSyncToast({
          type: 'error',
          text: `Sync Error: ${res.error || 'Failed to sync team data.'}`,
        });
      }
    } catch (err) {
      setSyncToast({ type: 'error', text: `Sync error: ${err.message}` });
    } finally {
      setIsSyncing(false);
    }
  };

  // Active manager display object
  const currentManager = useMemo(() => {
    return (
      managers.find((m) => m.id === activeManagerId) || {
        id: activeManagerId,
        name: activeManagerId === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'Balaji' : 'Ramakrishna',
        email: activeManagerId === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'balaji@applywizz.com' : 'ramakrishna@applywizz.com',
      }
    );
  }, [managers, activeManagerId]);

  // Filtered clients by selected CA
  const filteredClientRows = useMemo(() => {
    if (selectedCA === 'All') return teamClients;
    return teamClients.filter((c) => c.assigned === selectedCA);
  }, [teamClients, selectedCA]);

  // Team summary KPIs
  const teamMetrics = useMemo(() => {
    const totalApps = filteredClientRows.reduce((acc, c) => acc + (c.apps || 0), 0);
    const totalSubmitted = filteredClientRows.reduce((acc, c) => acc + (c.submitted || 0), 0);
    const totalApplied = filteredClientRows.reduce((acc, c) => acc + (c.applied || 0), 0);

    return {
      total: totalApps || applications.length,
      submitted: totalSubmitted || applications.filter((a) => a.status === 'submitted').length,
      applied: totalApplied || applications.filter((a) => a.status === 'in_progress' || a.status === 'started').length,
    };
  }, [filteredClientRows, applications]);

  // Check if session email is a locked manager (only Developer gets toggle buttons)
  const isDirectManagerLogin = useMemo(() => {
    if (user?.role === 'dev') return false; // Developer gets toggle
    return user?.role === 'manager' || (user?.email || '').toLowerCase().includes('balaji') || (user?.email || '').toLowerCase().includes('ramakrishna');
  }, [user]);

  // Page redirection handler for operator details
  const handleOpenOperatorDetails = (op) => {
    const fullOp = { ...op, manager_name: currentManager.name };
    setSelectedOperatorDetails(fullOp);
    window.history.pushState(
      { page: 'operator-details', email: op.email },
      '',
      `#operator-details?email=${encodeURIComponent(op.email)}`
    );
  };

  const handleBackFromDetails = () => {
    setSelectedOperatorDetails(null);
    if (window.location.hash.startsWith('#operator-details')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Synchronize with URL hash for browser Back/Forward navigation
  useEffect(() => {
    const checkHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#operator-details')) {
        const params = new URLSearchParams(hash.replace('#operator-details?', ''));
        const email = params.get('email');
        if (email && operators.length > 0) {
          const found = operators.find((o) => o.email.toLowerCase() === email.toLowerCase());
          if (found) {
            setSelectedOperatorDetails({ ...found, manager_name: currentManager.name });
          }
        }
      } else {
        setSelectedOperatorDetails(null);
      }
    };

    checkHash();
    window.addEventListener('hashchange', checkHash);
    return () => window.removeEventListener('hashchange', checkHash);
  }, [operators, currentManager]);

  return (
    <div className="dashboard-container">
      {selectedOperatorDetails ? (
        <OperatorDetailsPage
          operator={selectedOperatorDetails}
          onBack={handleBackFromDetails}
          dateStr={activeWorkDate || date}
          sourceDashboard="manager"
        />
      ) : (
        <>
          {/* Top Manager Filter Controls */}
          <div className="manager-top-control-bar">
        <div className="mtc-left">
          {/* Sub Tabs */}
          <div className="sub-tab-bar">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`sub-tab-btn ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="mtc-right">
          {/* Manager Persona Scope: Locked if manager logged in; distinct toggle buttons if dev/admin audit */}
          {isDirectManagerLogin ? (
            <div className="filter-ca-box">
              <span className="control-label-micro">TEAM SCOPE (LOCKED)</span>
              <span style={{ fontWeight: 'bold', color: '#38bdf8', padding: '0.25rem 0.6rem', background: '#0f172a', borderRadius: '4px', border: '1px solid #334155', fontSize: '0.85rem' }}>
                {currentManager.name} ({currentManager.email})
              </span>
            </div>
          ) : (
            <div className="filter-ca-box">
              <span className="control-label-micro">OPERATIONAL MANAGER SCOPE</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  onClick={() => setActiveManagerId('9dc9376e-fbc5-440b-932f-38da10b89a70')}
                  style={{
                    padding: '3px 8px',
                    fontSize: '0.8rem',
                    borderRadius: '4px',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                    background: activeManagerId === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? '#0284c7' : '#1e293b',
                    color: '#fff',
                    fontWeight: activeManagerId === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'bold' : 'normal',
                  }}
                >
                  Balaji&apos;s Team
                </button>
                <button
                  type="button"
                  onClick={() => setActiveManagerId('bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744')}
                  style={{
                    padding: '3px 8px',
                    fontSize: '0.8rem',
                    borderRadius: '4px',
                    border: '1px solid #334155',
                    cursor: 'pointer',
                    background: activeManagerId === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' ? '#0284c7' : '#1e293b',
                    color: '#fff',
                    fontWeight: activeManagerId === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' ? 'bold' : 'normal',
                  }}
                >
                  Ramakrishna&apos;s Team
                </button>
              </div>
            </div>
          )}

          {/* Filter by Career Associate (Scoped ONLY to this manager's CAs) */}
          <div className="filter-ca-box">
            <span className="control-label-micro">FILTER BY CAREER ASSOCIATE</span>
            <select
              value={selectedCA}
              onChange={(e) => setSelectedCA(e.target.value)}
              className="manager-select-input"
            >
              <option value="All">All {currentManager.name}&apos;s CAs ({operators.length})</option>
              {operators.map((op) => (
                <option key={op.id || op.email} value={op.email}>
                  {op.name} ({op.email})
                </option>
              ))}
            </select>
          </div>

          {/* Date Range Selector */}
          <div className="filter-range-box">
            <span className="control-label-micro">DATE RANGE</span>
            <div className="range-pills">
              {['Today', 'Day', 'Week', 'Month'].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`range-pill-btn ${dateRange.toLowerCase() === r.toLowerCase() ? 'active' : ''}`}
                  onClick={() => handleDateRangeChange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Mode & Refresh Buttons */}
          <button
            type="button"
            className={`video-btn-ops ${opsMode ? 'active' : ''}`}
            onClick={() => setOpsMode(!opsMode)}
          >
            {opsMode ? '✓ Ops Active' : 'Ops mode'}
          </button>
          <button
            type="button"
            disabled={isSyncing}
            className="video-btn-refresh"
            style={{
              background: '#0284c7',
              color: '#ffffff',
              borderColor: '#38bdf8',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontWeight: 'bold',
            }}
            onClick={handleTeamSync}
            title={`Sync live allocations and work history for ${currentManager.name}'s team`}
          >
            <span style={{ animation: isSyncing ? 'spin 1s linear infinite' : 'none' }}>🔄</span>
            {isSyncing ? 'Syncing...' : 'Sync Team Data'}
          </button>
          <button
            type="button"
            className="video-btn-refresh"
            onClick={() => loadManagerData()}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Sync Toast Notification */}
      {syncToast && (
        <div style={{
          padding: '8px 16px',
          background: syncToast.type === 'success' ? '#064e3b' : '#7f1d1d',
          color: syncToast.type === 'success' ? '#6ee7b7' : '#fca5a5',
          borderBottom: `1px solid ${syncToast.type === 'success' ? '#059669' : '#dc2626'}`,
          fontSize: '0.85rem',
          fontWeight: '600',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>{syncToast.text}</span>
          <button
            type="button"
            onClick={() => setSyncToast(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '1rem' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Holiday / Weekend Date Notice */}
      {isFallbackDate && (
        <div style={{ padding: '8px 16px', background: '#451a03', color: '#fed7aa', fontSize: '0.8rem', borderBottom: '1px solid #78350f', display: 'flex', justifyContent: 'space-between' }}>
          <span>
            ℹ️ Viewing active team work records for <strong>{activeWorkDate}</strong> (Nearest active workday; Sunday/holiday fallback).
          </span>
          <span>Showing <strong>{filteredClientRows.length}</strong> unique clients under <strong>{currentManager.name}</strong></span>
        </div>
      )}

      {loading && <div className="loading-indicator">Loading isolated team records for {currentManager.name}...</div>}

      {/* 1. HOME TAB */}
      {activeTab === 'Home' && (
        <div className="tab-body-fade">
          {/* Top Scoped KPIs */}
          <div className="video-manager-kpi-row">
            <div className="video-kpi-box">
              <span className="vkpi-label">TOTAL APPLICATIONS</span>
              <span className="vkpi-val">{teamMetrics.total}</span>
            </div>
            <div className="video-kpi-box highlighted">
              <span className="vkpi-label">SUBMITTED (TEAM)</span>
              <span className="vkpi-val">{teamMetrics.submitted}</span>
            </div>
            <div className="video-kpi-box">
              <span className="vkpi-label">APPLIED (TEAM)</span>
              <span className="vkpi-val">{teamMetrics.applied}</span>
            </div>
          </div>

          {/* Scoped Client Allocation Table (Strictly this manager's clients, with exact assigned CA) */}
          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>CLIENT NAME</th>
                  <th>AWL ID</th>
                  <th>APPS</th>
                  <th>SUBMITTED</th>
                  <th>APPLIED</th>
                  <th>PENDING</th>
                  <th>FAILED</th>
                  <th>ASSIGNED CA EMAIL</th>
                </tr>
              </thead>
              <tbody>
                {filteredClientRows.length > 0 ? (
                  filteredClientRows.map((row) => (
                    <tr key={row.applywizz_id}>
                      <td>
                        <span className="client-bold-tag">{row.name}</span>
                        {row.client_email && (
                          <div style={{ fontSize: '0.78rem', color: '#38bdf8', marginTop: '2px' }}>
                            {row.client_email}
                          </div>
                        )}
                      </td>
                      <td>
                        <a
                          href={`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(row.applywizz_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="app-id-tag"
                          style={{ textDecoration: 'none' }}
                        >
                          {row.applywizz_id}
                        </a>
                      </td>
                      <td><strong>{row.apps}</strong></td>
                      <td>
                        <span style={{ color: row.submitted > 0 ? '#10b981' : '#94a3b8', fontWeight: 'bold' }}>
                          {row.submitted}
                        </span>
                      </td>
                      <td>{row.applied}</td>
                      <td>{row.pending}</td>
                      <td>
                        <span style={{ color: row.failed > 0 ? '#ef4444' : '#94a3b8' }}>
                          {row.failed}
                        </span>
                      </td>
                      <td>
                        <span className="assigned-email-link" style={{ fontWeight: 'bold', color: '#38bdf8' }}>
                          {row.assigned}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      No client applications assigned to {currentManager.name}&apos;s team for {activeWorkDate || date}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. OPERATORS TAB — This manager's CAs only */}
      {activeTab === 'Operators' && (
        <div className="tab-body-fade">
          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>OPERATOR NAME</th>
                  <th>EMAIL</th>
                  <th>STATUS</th>
                  <th>ASSIGNED CLIENTS</th>
                  <th>SUBMITTED</th>
                  <th>APPLIED</th>
                  <th style={{ textAlign: 'center' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {operators.length > 0 ? (
                  operators.map((op) => (
                    <tr key={op.id || op.email}>
                      <td>
                        <div className="operator-cell">
                          <span className="op-name">{op.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className="op-email">{op.email}</span>
                      </td>
                      <td>
                        <span className={`video-status-tag ${(op.status || 'inactive').toLowerCase()}`}>
                          {(op.status || 'inactive').toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => handleOpenOperatorDetails(op)}
                          style={{
                            background: (op.assigned || 0) > 0 ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                            border: `1px solid ${(op.assigned || 0) > 0 ? '#0284c7' : '#334155'}`,
                            color: (op.assigned || 0) > 0 ? '#38bdf8' : '#94a3b8',
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontWeight: 'bold',
                            fontSize: '0.82rem',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            transition: 'all 0.2s',
                          }}
                          title="Click to view allotted clients & details"
                        >
                          <span>{op.assigned || 0} Clients</span>
                        </button>
                      </td>
                      <td>
                        <span style={{ color: op.submitted > 0 ? '#10b981' : '#94a3b8', fontWeight: 'bold' }}>
                          {op.submitted}
                        </span>
                      </td>
                      <td>{op.applied}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => handleOpenOperatorDetails(op)}
                          style={{
                            background: '#1e293b',
                            border: '1px solid #334155',
                            color: '#38bdf8',
                            padding: '4px 10px',
                            borderRadius: '4px',
                            fontSize: '0.78rem',
                            fontWeight: '600',
                            cursor: 'pointer',
                          }}
                          title="Inspect CA allotted clients & history"
                        >
                          View Details
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      No operators currently assigned under {currentManager.name}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. ACTIVITY TAB */}
      {activeTab === 'Activity' && (
        <div className="tab-body-fade">
          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>CLIENT NAME</th>
                  <th>AWL ID</th>
                  <th>ASSIGNED CA</th>
                  <th>EMAILS SUBMITTED</th>
                  <th>JOBS APPLIED</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredClientRows.length > 0 ? (
                  filteredClientRows.map((c) => (
                    <tr key={c.applywizz_id}>
                      <td><strong>{c.name}</strong></td>
                      <td><span className="app-id-tag">{c.applywizz_id}</span></td>
                      <td><span className="assigned-email-link">{c.assigned}</span></td>
                      <td>{c.submitted}</td>
                      <td>{c.applied}</td>
                      <td><span className="video-status-tag submitted">COMPLETED</span></td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      No activity recorded for {currentManager.name}&apos;s team.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. REPORTS TAB */}
      {activeTab === 'Reports' && (
        <div className="tab-body-fade">
          <div className="video-card-section">
            <span className="vcs-title">
              {currentManager.name.toUpperCase()} TEAM PERFORMANCE ROLLUP ({timeframe.toUpperCase()})
            </span>
            <div className="video-admin-kpi-grid" style={{ marginTop: '1rem' }}>
              <div className="video-kpi-box">
                <span className="vkpi-label">TOTAL OPERATORS</span>
                <span className="vkpi-val">{operators.length}</span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label">ACTIVE CLIENTS</span>
                <span className="vkpi-val">{filteredClientRows.length}</span>
              </div>
              <div className="video-kpi-box highlighted">
                <span className="vkpi-label">SUBMITTED QUOTA</span>
                <span className="vkpi-val">{teamMetrics.submitted}</span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label">AVG PER OPERATOR</span>
                <span className="vkpi-val">
                  {operators.length > 0 ? Math.round(teamMetrics.submitted / operators.length) : 0}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 5. GUIDE TAB */}
      {activeTab === 'Guide' && (
        <div className="tab-body-fade">
          <div className="video-card-section">
            <span className="vcs-title">OPERATIONAL MANAGER SOP</span>
            <p style={{ color: '#cbd5e1', lineHeight: '1.6', marginTop: '0.5rem' }}>
              This dashboard is pre-scoped strictly to <strong>{currentManager.name} ({currentManager.email})</strong>. All client allocations, team CAs, and quota statistics are isolated to prevent cross-manager data leakage.
            </p>
            <ul style={{ color: '#94a3b8', marginTop: '0.75rem', paddingLeft: '1.25rem', lineHeight: '1.6' }}>
              <li><strong>Home Tab:</strong> Displays live client queues and submission counts for this manager&apos;s team with exact assigned CA emails.</li>
              <li><strong>Operators Tab:</strong> Direct roster of Career Associates reporting to {currentManager.name}.</li>
              <li><strong>Zero Cross-Manager Bleed:</strong> Balaji&apos;s team and Ramakrishna&apos;s team never share clients or CAs.</li>
            </ul>
          </div>
        </div>
      )}
        </>
      )}

      {/* CA Allotted Clients & History Details Modal */}
      <CAClientDetailsModal
        isOpen={Boolean(selectedOperatorForModal)}
        onClose={() => setSelectedOperatorForModal(null)}
        operator={selectedOperatorForModal}
        dateStr={activeWorkDate || date}
      />
    </div>
  );
}
