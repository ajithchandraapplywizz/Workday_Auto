import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchCAEmails,
  fetchCAWorkHistory,
  fetchClientDetails,
  fetchAssignedClientsForCA,
  fetchApplicationsDynamic,
  fetchAutomationTrace,
  getISTDateBounds,
  syncLiveCAData,
  formatClientCompanyEmail,
} from '../services/api';
import ApplicationFormReviewModal from '../components/ApplicationFormReviewModal';

export default function OperatorDashboard({ operatorView = 'dashboard' }) {
  const { user, date, setDate, timeframe, smartSyncStatus, smartSyncMessage } = useAuth();

  // Local manual-sync state (backup button only)
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');

  // Active CA identity (strictly scoped to logged-in operator session)
  const [caRoster, setCaRoster] = useState([]);
  const [sessionCaEmail, setSessionCaEmail] = useState(
    user?.email && user?.email.includes('@') ? user.email.toLowerCase().trim() : 'manasa@applywizz.com'
  );

  // Synchronize with logged in operator session
  useEffect(() => {
    if (user?.email && user?.email.includes('@')) {
      setSessionCaEmail(user.email.toLowerCase().trim());
    }
  }, [user?.email]);

  // Load CA roster ONLY if developer is logged in (to enable developer oversight)
  useEffect(() => {
    if (user?.role !== 'dev') return;
    async function loadRoster() {
      const res = await fetchCAEmails();
      if (res.success && res.users?.length) {
        setCaRoster(res.users);
      }
    }
    loadRoster();
  }, [user?.role]);

  const [activeWorkDate, setActiveWorkDate] = useState(date);
  const [isFallbackDate, setIsFallbackDate] = useState(false);

  // Core candidate, application, and history states
  const [candidates, setCandidates] = useState([]);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [clientDetails, setClientDetails] = useState(null);
  const [applications, setApplications] = useState([]);
  const [selectedApp, setSelectedApp] = useState(null);
  const [traceLogs, setTraceLogs] = useState([]);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [workHistoryRecords, setWorkHistoryRecords] = useState([]);

  // Form Review Modal state
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewTargetApp, setReviewTargetApp] = useState(null);

  const handleOpenReview = (app) => {
    setReviewTargetApp(app);
    setShowReviewModal(true);
  };

  const handleReviewSubmitted = ({ applywizzId, jobUrl }) => {
    setApplications((prev) =>
      prev.map((a) =>
        a.id === reviewTargetApp?.id || (a.applywizz_id === applywizzId && (a.job_url === jobUrl || a.url === jobUrl))
          ? { ...a, status: 'submitted' }
          : a
      )
    );
    if (selectedCandidate) {
      handleSelectCandidate(selectedCandidate);
    }
  };

  // Load candidate directory assigned to this CA on the active date (with holiday rollback)
  const loadAssignedClients = async (overrideDate) => {
    setLoading(true);
    const targetDate = overrideDate || date;
    try {
      const res = await fetchAssignedClientsForCA({
        caEmail: sessionCaEmail,
        atDate: targetDate,
      });

      if (res.activeDate) {
        setActiveWorkDate(res.activeDate);
        setIsFallbackDate(Boolean(res.isFallback));
        if (res.activeDate !== date && setDate) {
          setDate(res.activeDate);
        }
      }

      if (res.success && res.assignments?.length) {
        const mapped = res.assignments.map((a) => ({
          id: a.applywizz_id,
          name: a.client_name || a.applywizz_id,
          client_email: a.client_email,
          jobs_applied: a.jobs_applied || 0,
          emails_submitted: a.emails_submitted || 0,
          date: a.date || res.activeDate,
        }));
        setCandidates(mapped);
        if (mapped.length > 0) {
          handleSelectCandidate(mapped[0]);
        }
      } else {
        setCandidates([]);
        setSelectedCandidate(null);
        setClientDetails(null);
        setApplications([]);
      }
    } catch (err) {
      console.error('Error loading assigned candidates:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAssignedClients();
  }, [sessionCaEmail, date]);

  // On-demand live synchronization with CA portal
  const handleSyncLiveCA = async () => {
    setSyncing(true);
    setSyncMessage('');
    try {
      const res = await syncLiveCAData({ caEmail: sessionCaEmail, dateStr: date });
      if (res.success) {
        if (res.activeDate && res.activeDate !== date && setDate) {
          setDate(res.activeDate);
        }
        setActiveWorkDate(res.activeDate || date);
        setIsFallbackDate(Boolean(res.isFallback));
        const fbTag = res.isFallback ? ' (Previous Active Day)' : '';
        setSyncMessage(`Synced ${res.count} clients for ${res.activeDate}${fbTag}`);
        await loadAssignedClients(res.activeDate);
      } else {
        setSyncMessage(res.message || 'Sync completed');
      }
    } catch (err) {
      setSyncMessage('Sync error: ' + err.message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(''), 6000);
    }
  };

  // Handle selecting a candidate
  const handleSelectCandidate = async (candidate) => {
    setSelectedCandidate(candidate);
    setLoadingDetails(true);
    setTraceLogs([]);
    setSelectedApp(null);

    try {
      const [details, appsRes] = await Promise.all([
        fetchClientDetails(candidate.id),
        fetchApplicationsDynamic({ applywizzId: candidate.id, limit: 50 }),
      ]);

      if (details.success && details.client) {
        setClientDetails(details.client);
      } else {
        setClientDetails(null);
      }

      if (appsRes.success && appsRes.applications?.length) {
        setApplications(appsRes.applications);
        setSelectedApp(appsRes.applications[0]);
        // Load trace for first app
        const trace = await fetchAutomationTrace(appsRes.applications[0].id);
        if (trace.success) {
          setTraceLogs(trace.trace);
        }
      } else {
        setApplications([]);
      }
    } catch (e) {
      console.error('Error selecting candidate:', e);
    } finally {
      setLoadingDetails(false);
    }
  };

  // Switch inspected application in queue
  const handleSelectApp = async (app) => {
    setSelectedApp(app);
    const trace = await fetchAutomationTrace(app.id);
    if (trace.success) {
      setTraceLogs(trace.trace);
    }
  };

  // Live polling: automatically reflects real-time background bot progress in CA portal
  useEffect(() => {
    if (!selectedCandidate?.id) return;
    let isMounted = true;

    const refreshActiveCandidateApps = async () => {
      try {
        const appsRes = await fetchApplicationsDynamic({ applywizzId: selectedCandidate.id, limit: 50 });
        if (!isMounted) return;
        if (appsRes.success && appsRes.applications) {
          setApplications(appsRes.applications);
          setSelectedApp((curr) => {
            if (!curr) return appsRes.applications[0] || null;
            const updated = appsRes.applications.find((a) => a.id === curr.id);
            return updated || curr;
          });
        }
      } catch (err) {
        console.warn('Silent live polling error:', err);
      }
    };

    const intervalId = setInterval(refreshActiveCandidateApps, 3500);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [selectedCandidate?.id]);

  // Load Work History for Stats Tab with IST bounds
  useEffect(() => {
    if (operatorView !== 'stats') return;
    let isMounted = true;
    async function loadHistory() {
      setLoading(true);
      try {
        const bounds = getISTDateBounds(date, timeframe);
        const res = await fetchCAWorkHistory({
          from: bounds.startDateStr,
          to: bounds.endDateStr,
          caEmail: sessionCaEmail,
        });

        if (!isMounted) return;
        if (res.success) {
          setWorkHistoryRecords(res.records || []);
        }
      } catch (err) {
        console.error('Error loading CA work history:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadHistory();
    return () => { isMounted = false; };
  }, [operatorView, sessionCaEmail, date, timeframe]);

  // Overall counts for this CA in this period
  const totals = useMemo(() => {
    const totalCandidatesApps = candidates.reduce((acc, c) => acc + (Number(c.jobs_applied) || 0), 0);
    const totalCandidatesSubmitted = candidates.reduce((acc, c) => acc + (Number(c.emails_submitted) || 0), 0);
    const currentTotal = applications.length;
    const currentSubmitted = applications.filter((a) => a.status === 'submitted').length;
    const currentFailed = applications.filter((a) => a.status === 'failed').length;
    return {
      total: Math.max(totalCandidatesApps, currentTotal),
      submitted: Math.max(totalCandidatesSubmitted, currentSubmitted),
      failed: currentFailed,
    };
  }, [applications, candidates]);

  // Filtered candidate list with safe null checks
  const filteredCandidates = useMemo(() => {
    const q = (candidateSearch || '').toLowerCase().trim();
    return candidates.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const id = (c.id || '').toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }, [candidates, candidateSearch]);

  return (
    <div className="operator-portal-layout">

      {/* ── Smart Auto-Sync Banner ──────────────────────────────────── */}
      {(smartSyncStatus !== 'idle' || syncMessage) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          padding: '0.45rem 1.25rem',
          fontSize: '0.82rem',
          fontWeight: '600',
          background: smartSyncStatus === 'syncing' ? 'rgba(124,58,237,0.18)'
                    : smartSyncStatus === 'synced'  ? 'rgba(16,185,129,0.15)'
                    : smartSyncStatus === 'failed'  ? 'rgba(239,68,68,0.12)'
                    : 'rgba(255,255,255,0.06)',
          borderBottom: smartSyncStatus === 'syncing' ? '1px solid rgba(124,58,237,0.4)'
                      : smartSyncStatus === 'synced'  ? '1px solid rgba(16,185,129,0.35)'
                      : '1px solid rgba(239,68,68,0.3)',
          color: smartSyncStatus === 'syncing' ? '#a78bfa'
               : smartSyncStatus === 'synced'  ? '#34d399'
               : '#f87171',
          letterSpacing: '0.02em',
          transition: 'all 0.4s ease',
        }}>
          <span style={{ fontSize: '1rem' }}>
            {smartSyncStatus === 'syncing' ? '🔄' : smartSyncStatus === 'synced' ? '✅' : '⚠️'}
          </span>
          <span>
            {smartSyncStatus === 'syncing' ? 'Smart Sync running — loading your clients automatically...' : (smartSyncMessage || syncMessage)}
          </span>
          {smartSyncStatus === 'syncing' && (
            <span style={{
              width: '10px', height: '10px',
              borderRadius: '50%',
              background: '#7c3aed',
              display: 'inline-block',
              animation: 'pulse 1.2s infinite',
              marginLeft: '4px',
            }} />
          )}
        </div>
      )}


      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 1.25rem', background: '#0b1120', borderBottom: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 'bold' }}>
            OPERATOR:
          </span>
          {user?.role === 'dev' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.68rem', background: '#0284c7', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                DEV OVERRIDE
              </span>
              <select
                value={sessionCaEmail}
                onChange={(e) => setSessionCaEmail(e.target.value)}
                style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #334155', borderRadius: '4px', padding: '0.25rem 0.5rem', fontSize: '0.85rem', fontWeight: 'bold' }}
              >
                {caRoster.map((ca) => (
                  <option key={ca.id} value={ca.email}>
                    {ca.name} ({ca.email})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ color: '#38bdf8', fontSize: '0.9rem', fontWeight: '800' }}>
                {user?.name || sessionCaEmail.split('@')[0]}
              </span>
              <span style={{ color: '#64748b', fontSize: '0.8rem', fontFamily: 'monospace' }}>
                ({sessionCaEmail})
              </span>
              <span style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', fontSize: '0.68rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>
                AUTHENTICATED
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          {/* Active Date Tag */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
            <span style={{ color: '#94a3b8' }}>DATE:</span>
            <strong style={{ color: '#f8fafc', fontFamily: 'monospace' }}>{activeWorkDate}</strong>
            {isFallbackDate && (
              <span
                title="No records found on selected date. Rolled back to nearest active working day."
                style={{ background: '#78350f', color: '#fde68a', fontSize: '0.68rem', padding: '1px 6px', borderRadius: '4px', fontWeight: 'bold' }}
              >
                Fallback
              </span>
            )}
          </div>

          {/* Sync Button */}
          <button
            type="button"
            disabled={syncing}
            onClick={handleSyncLiveCA}
            style={{
              background: syncing ? '#334155' : '#7c3aed',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '4px 10px',
              fontSize: '0.78rem',
              fontWeight: 'bold',
              cursor: syncing ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              transition: 'background 0.2s',
            }}
          >
            {syncing ? 'Syncing...' : '🔄 Sync Live CA Portal'}
          </button>

          {syncMessage && (
            <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: 'bold' }}>
              {syncMessage}
            </span>
          )}

          <div style={{ display: 'flex', gap: '1.25rem', fontSize: '0.85rem' }}>
            <span>TOTAL APPS: <strong>{totals.total}</strong></span>
            <span style={{ color: '#10b981' }}>SUBMITTED: <strong>{totals.submitted}</strong></span>
            <span style={{ color: '#ef4444' }}>FAILED: <strong>{totals.failed}</strong></span>
          </div>
        </div>
      </div>

      {loading && <div className="loading-indicator">Synchronizing candidate records for {sessionCaEmail}...</div>}

      {/* STATS VIEW */}
      {operatorView === 'stats' ? (
        <div className="tab-body-fade width-full" style={{ padding: '1.5rem' }}>
          <div className="operator-stats-view">
            <h2 className="stats-heading">Career Associate Work History ({timeframe.toUpperCase()})</h2>
            <p className="stats-sub" style={{ color: '#94a3b8' }}>
              Snapshot work records for <strong>{sessionCaEmail}</strong> queried from live CA Management API with IST timezone bounds.
            </p>

            <div className="video-admin-kpi-grid" style={{ marginTop: '1.25rem' }}>
              <div className="video-kpi-box">
                <span className="vkpi-label">TOTAL WORK ENTRIES</span>
                <span className="vkpi-val">{workHistoryRecords.length}</span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label">JOBS APPLIED</span>
                <span className="vkpi-val">
                  {workHistoryRecords.reduce((acc, r) => acc + (Number(r.jobs_applied) || 0), 0)}
                </span>
              </div>
              <div className="video-kpi-box highlighted">
                <span className="vkpi-label">EMAILS SUBMITTED</span>
                <span className="vkpi-val">
                  {workHistoryRecords.reduce((acc, r) => acc + (Number(r.emails_submitted) || 0), 0)}
                </span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label">REQUIRED TARGET</span>
                <span className="vkpi-val">
                  {workHistoryRecords.reduce((acc, r) => acc + (Number(r.emails_required) || 0), 0)}
                </span>
              </div>
            </div>

            <div className="video-table-container" style={{ marginTop: '1.5rem' }}>
              <table className="video-data-table">
                <thead>
                  <tr>
                    <th>DATE</th>
                    <th>CLIENT NAME</th>
                    <th>APPLYWIZZ ID</th>
                    <th>JOBS APPLIED</th>
                    <th>EMAILS SUBMITTED</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {workHistoryRecords.length > 0 ? (
                    workHistoryRecords.map((r, i) => (
                      <tr key={i}>
                        <td>{r.date}</td>
                        <td><strong>{r.client_name}</strong></td>
                        <td><span className="app-id-tag">{r.applywizz_id}</span></td>
                        <td>{r.jobs_applied || 0}</td>
                        <td>{r.emails_submitted || 0}</td>
                        <td>
                          <span className={`video-status-tag ${r.status?.toLowerCase() || 'submitted'}`}>
                            {r.status || 'DONE'}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                        No work history recorded for {sessionCaEmail} in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* DASHBOARD VIEW: Split Candidate Directory (Left) + Candidate & Application Review (Right) */
        <div className="operator-split-view">
          {/* Left Panel: Assigned Candidates Directory */}
          <aside className="operator-sidebar">
            <div className="sidebar-header-box">
              <div className="shb-title-row">
                <span className="shb-title">ASSIGNED CANDIDATES</span>
                <div className="shb-badges">
                  <span className="shb-badge red">{candidates.length} Clients</span>
                </div>
              </div>
              <div className="sidebar-search-box">
                <input
                  type="text"
                  value={candidateSearch}
                  onChange={(e) => setCandidateSearch(e.target.value)}
                  placeholder="Search name or AWL ID..."
                  className="sidebar-search-input"
                />
              </div>
            </div>

            {isFallbackDate && (
              <div style={{ padding: '6px 12px', background: '#451a03', color: '#fed7aa', fontSize: '0.75rem', borderBottom: '1px solid #78350f' }}>
                ℹ️ Active Workday: <strong>{activeWorkDate}</strong> (Sunday/Holiday fallback)
              </div>
            )}

            <div className="sidebar-candidate-list">
              {filteredCandidates.length > 0 ? (
                filteredCandidates.map((c) => (
                  <div
                    key={c.id}
                    className={`candidate-card-item ${selectedCandidate?.id === c.id ? 'active' : ''}`}
                    onClick={() => handleSelectCandidate(c)}
                  >
                    <div className="cci-name-row">
                      <span className="cci-name">{c.name}</span>
                    </div>
                    <div className="cci-id-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="cci-awl">{c.id}</span>
                      <span style={{ fontSize: '0.72rem', color: (c.jobs_applied || 0) > 0 ? '#38bdf8' : '#94a3b8', fontWeight: (c.jobs_applied || 0) > 0 ? 'bold' : 'normal' }}>
                        {c.jobs_applied || 0} Apps
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: '#64748b' }}>
                  No candidates assigned to this CA for {activeWorkDate || date}.
                </div>
              )}
            </div>
          </aside>

          {/* Right Main Panel: Detail Panel & Application Queue */}
          <main className="operator-workspace">
            {selectedCandidate ? (
              <div className="candidate-detail-screen">
                {/* 1. Candidate Full Profile Detail Panel from get-client-details */}
                <div className="candidate-info-card" style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', padding: '1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <h2 style={{ fontSize: '1.35rem', color: '#f8fafc', margin: '0 0 0.25rem 0' }}>
                        {clientDetails?.full_name || selectedCandidate.name}
                      </h2>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <span className="app-id-tag">{selectedCandidate.id}</span>
                        {clientDetails?.visa_type && (
                          <span style={{ background: '#0284c7', color: '#fff', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px' }}>
                            {clientDetails.visa_type}
                          </span>
                        )}
                        {clientDetails?.sponsorship && (
                          <span style={{ background: '#7c3aed', color: '#fff', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px' }}>
                            {clientDetails.sponsorship}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right', fontSize: '0.85rem', color: '#94a3b8' }}>
                      <div>Work Email: <strong style={{ color: '#38bdf8' }}>{formatClientCompanyEmail(clientDetails?.full_name || selectedCandidate.name, clientDetails?.email || selectedCandidate.client_email, clientDetails?.company_email)}</strong></div>
                      <div>Phone: <strong>{clientDetails?.callable_phone || clientDetails?.whatsapp_number || '—'}</strong></div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #1e293b', fontSize: '0.85rem' }}>
                    <div>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>ROLE PREFERENCES</span>
                      <strong style={{ color: '#e2e8f0' }}>{clientDetails?.job_role_preferences || 'Software Engineer / Data'}</strong>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>SALARY RANGE</span>
                      <strong style={{ color: '#e2e8f0' }}>{clientDetails?.salary_range || '$100k – $140k'}</strong>
                    </div>
                    <div>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '0.75rem' }}>TARGET LOCATIONS</span>
                      <strong style={{ color: '#e2e8f0' }}>{clientDetails?.location_preferences || 'Remote / Hybrid (USA)'}</strong>
                    </div>
                  </div>
                </div>

                {/* 2. Assigned Workday Application Queue */}
                <div style={{ marginTop: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <h3 style={{ color: '#e2e8f0', fontSize: '1.1rem', margin: 0 }}>
                      Assigned Workday Application Queue
                    </h3>
                    {applications.length > 0 && (
                      <button
                        type="button"
                        className="video-btn-start"
                        style={{ padding: '5px 14px', fontSize: '0.8rem', background: '#0284c7', borderColor: '#38bdf8' }}
                        onClick={() => handleOpenReview(selectedApp || applications[0])}
                      >
                        📋 Review Application Form
                      </button>
                    )}
                  </div>

                  <div className="video-table-container">
                    <table className="video-data-table">
                      <thead>
                        <tr>
                          <th>JOB TITLE</th>
                          <th>COMPANY</th>
                          <th>ATS</th>
                          <th>STATUS</th>
                          <th>ACTION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {applications.length > 0 ? (
                          applications.map((app) => (
                            <tr
                              key={app.id}
                              style={{ background: selectedApp?.id === app.id ? '#1e293b' : 'transparent', cursor: 'pointer' }}
                              onClick={() => {
                                handleSelectApp(app);
                                const s = (app.status || '').toLowerCase();
                                if (['ready_for_review', 'reached_review', 'pre_resolved', 'submitted', 'completed'].includes(s)) {
                                  handleOpenReview(app);
                                }
                              }}
                            >
                              <td>
                                <strong>{app.job_title || app.role_title || 'Workday Position'}</strong>
                              </td>
                              <td>{app.company || 'Workday Tenant'}</td>
                              <td>{app.ats || 'Workday'}</td>
                              <td>
                                {(() => {
                                  const s = (app.status || '').toLowerCase();
                                  const lastUpdated = new Date(app.updated_at || app.created_at || 0).getTime();
                                  const isLiveActive = lastUpdated && (Date.now() - lastUpdated < 3 * 60 * 1000);

                                  if (s === 'failed') {
                                    return (
                                      <span className="video-status-tag failed" title={app.failure_reason}>
                                        Failed – {app.error_category || app.failure_reason || 'Unknown error'}
                                      </span>
                                    );
                                  }
                                  if (s === 'submitted') {
                                    return <span className="video-status-tag submitted">SUBMITTED</span>;
                                  }
                                  if (s === 'ready_for_review' || s === 'reached_review') {
                                    return <span className="video-status-tag ready_for_review">READY TO REVIEW & SUBMIT</span>;
                                  }
                                  if (['in_flight', 'processing', 'in_progress', 'started', 'applying'].includes(s)) {
                                    if (isLiveActive) {
                                      return <span className="video-status-tag in_flight">BOT FILLING IN BACKGROUND</span>;
                                    }
                                    return <span className="video-status-tag queued">QUEUED / READY</span>;
                                  }
                                  if (s === 'pending' || s === 'queued') {
                                    return <span className="video-status-tag queued">IN QUEUE</span>;
                                  }
                                  return <span className={`video-status-tag ${s || 'queued'}`}>{(app.status || 'QUEUED').toUpperCase()}</span>;
                                })()}
                              </td>
                              <td>
                                {(() => {
                                  const s = (app.status || '').toLowerCase();
                                  const lastUpdated = new Date(app.updated_at || app.created_at || 0).getTime();
                                  const isLiveActive = lastUpdated && (Date.now() - lastUpdated < 3 * 60 * 1000);

                                  if (s === 'submitted' || s === 'completed') {
                                    return (
                                      <button
                                        type="button"
                                        className="video-btn-start"
                                        style={{
                                          padding: '5px 12px',
                                          fontSize: '0.8rem',
                                          background: '#065f46',
                                          borderColor: '#10b981',
                                          color: '#ecfdf5',
                                          cursor: 'pointer',
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectApp(app);
                                          handleOpenReview(app);
                                        }}
                                      >
                                        ✓ View Submitted Form
                                      </button>
                                    );
                                  }
                                  if (s === 'ready_for_review' || s === 'reached_review' || s === 'pre_resolved') {
                                    return (
                                      <button
                                        type="button"
                                        className="video-btn-start"
                                        style={{
                                          padding: '5px 14px',
                                          fontSize: '0.8rem',
                                          fontWeight: 'bold',
                                          background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                                          borderColor: '#38bdf8',
                                          color: '#ffffff',
                                          boxShadow: '0 0 10px rgba(56, 189, 248, 0.4)',
                                          cursor: 'pointer',
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectApp(app);
                                          handleOpenReview(app);
                                        }}
                                      >
                                        📋 Review & Confirm
                                      </button>
                                    );
                                  }
                                  if (['in_flight', 'processing', 'in_progress', 'started', 'applying'].includes(s)) {
                                    if (isLiveActive) {
                                      return (
                                        <span
                                          style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            fontSize: '0.78rem',
                                            color: '#38bdf8',
                                            fontWeight: 'bold',
                                            background: 'rgba(56, 189, 248, 0.1)',
                                            border: '1px solid rgba(56, 189, 248, 0.25)',
                                            padding: '4px 10px',
                                            borderRadius: '4px',
                                          }}
                                        >
                                          ⚡ Bot Filling Form...
                                        </span>
                                      );
                                    }
                                    return (
                                      <button
                                        type="button"
                                        className="video-btn-start"
                                        style={{
                                          padding: '5px 12px',
                                          fontSize: '0.8rem',
                                          fontWeight: 'bold',
                                          background: 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)',
                                          borderColor: '#38bdf8',
                                          color: '#ffffff',
                                          cursor: 'pointer',
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectApp(app);
                                          handleOpenReview(app);
                                        }}
                                      >
                                        📋 Review & Apply
                                      </button>
                                    );
                                  }
                                  if (s === 'pending' || s === 'queued' || s === 'in_queue') {
                                    return (
                                      <button
                                        type="button"
                                        className="video-btn-start"
                                        style={{
                                          padding: '4px 10px',
                                          fontSize: '0.78rem',
                                          background: 'rgba(56, 189, 248, 0.08)',
                                          borderColor: '#38bdf8',
                                          color: '#38bdf8',
                                          cursor: 'pointer',
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectApp(app);
                                          handleOpenReview(app);
                                        }}
                                      >
                                        📋 Review & Apply
                                      </button>
                                    );
                                  }
                                  if (s === 'failed') {
                                    return (
                                      <button
                                        type="button"
                                        className="video-btn-start"
                                        style={{
                                          padding: '4px 10px',
                                          fontSize: '0.78rem',
                                          background: 'rgba(239, 68, 68, 0.15)',
                                          borderColor: 'rgba(239, 68, 68, 0.4)',
                                          color: '#fca5a5',
                                          cursor: 'pointer',
                                        }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleSelectApp(app);
                                          handleOpenReview(app);
                                        }}
                                        title={app.failure_reason || app.error_category || 'View failure details'}
                                      >
                                        ⚠️ View Error
                                      </button>
                                    );
                                  }
                                  return (
                                    <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                                      {app.status ? app.status.toUpperCase() : 'QUEUED'}
                                    </span>
                                  );
                                })()}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', padding: '2.5rem', color: '#94a3b8' }}>
                              <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#cbd5e1' }}>
                                No applications recorded or queued yet for {selectedCandidate.id}.
                              </div>
                              <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.35rem' }}>
                                Application links will appear here once ingested for processing.
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* 3. Automation Execution Trace Panel */}
                <div style={{ marginTop: '1.5rem', background: '#090d16', border: '1px solid #1e293b', borderRadius: '8px', padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#38bdf8' }}>
                      AUTOMATION EXECUTION TRACE {selectedApp ? `(${selectedApp.job_title || selectedApp.company || selectedApp.id})` : ''}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      Live debug stream from public.automation_trace
                    </span>
                  </div>

                  <div style={{ maxHeight: '180px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.8rem', background: '#020617', padding: '0.75rem', borderRadius: '4px' }}>
                    {traceLogs.length > 0 ? (
                      traceLogs.map((log) => (
                        <div key={log.id} style={{ marginBottom: '0.35rem', color: '#cbd5e1' }}>
                          <span style={{ color: '#64748b' }}>[{new Date(log.ts).toLocaleTimeString()}]</span> Step {log.step_index}: {log.message}
                        </div>
                      ))
                    ) : (
                      <span style={{ color: '#64748b' }}>
                        No automation trace events logged yet for this application.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#64748b' }}>
                Select a candidate from the left directory to view profile and application queue.
              </div>
            )}
          </main>
        </div>
      )}

      {/* Interactive Form Review & Submit Modal */}
      {showReviewModal && (
        <ApplicationFormReviewModal
          isOpen={showReviewModal}
          onClose={() => {
            setShowReviewModal(false);
            setReviewTargetApp(null);
          }}
          applywizzId={selectedCandidate?.id || reviewTargetApp?.applywizz_id}
          jobUrl={reviewTargetApp?.job_url || reviewTargetApp?.url || ''}
          companyName={reviewTargetApp?.company || ''}
          roleTitle={reviewTargetApp?.job_title || reviewTargetApp?.role_title || ''}
          onSubmitted={handleReviewSubmitted}
        />
      )}
    </div>
  );
}
