import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchCAEmails,
  fetchCABotAutomationStats,
  fetchClientDetails,
  fetchAssignedClientsForCA,
  fetchClientApplications,
  fetchAutomationTrace,
  getISTDateBounds,
  syncLiveCAData,
  formatClientCompanyEmail,
} from '../services/api';
import ApplicationSlideDrawer from '../components/ApplicationSlideDrawer';

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
  const terminalBottomRef = useRef(null);

  useEffect(() => {
    if (terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [traceLogs]);
  const [botAutomationStats, setBotAutomationStats] = useState({
    totals: { total: 0, queued: 0, inFlight: 0, readyForReview: 0, submitted: 0, failed: 0 },
    clientStats: [],
  });

  // Calculate total application count across all assigned candidates for this CA
  const totalCaApplications = useMemo(() => {
    return candidates.reduce((sum, c) => sum + (c.jobs_applied || 0), 0);
  }, [candidates]);

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
          ? { ...a, status: 'in_progress' }
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
        fetchClientApplications(candidate.id),
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
        const trace = await fetchAutomationTrace({
          applicationId: appsRes.applications[0].id,
          applywizzId: candidate.id,
        });
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
    const trace = await fetchAutomationTrace({
      applicationId: app.id,
      applywizzId: selectedCandidate?.id,
    });
    if (trace.success) {
      setTraceLogs(trace.trace);
    }
  };

  // Live polling: automatically reflects real-time background bot progress in CA portal
  useEffect(() => {
    // If no candidate is selected OR total applications across all assigned clients is 0, do not poll
    if (!selectedCandidate?.id || totalCaApplications === 0) return;
    let isMounted = true;

    const refreshActiveCandidateApps = async () => {
      try {
        const appsRes = await fetchClientApplications(selectedCandidate.id);
        if (!isMounted) return;
        if (appsRes.success && appsRes.applications) {
          setApplications(appsRes.applications);
          setSelectedApp((curr) => {
            if (!curr) return appsRes.applications[0] || null;
            const updated = appsRes.applications.find((a) => a.id === curr.id);
            return updated || curr;
          });
        }
        const trace = await fetchAutomationTrace({
          applicationId: selectedApp?.id || null,
          applywizzId: selectedCandidate?.id || null,
        });
        if (isMounted && trace.success && (trace.logs || trace.trace)) {
          setTraceLogs(trace.logs || trace.trace);
        }
      } catch (err) {
        console.warn('Silent live polling error:', err);
      }
    };

    const intervalId = setInterval(refreshActiveCandidateApps, 2000);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [selectedCandidate?.id, totalCaApplications]);

  // Load Live Bot Automation Stats for Stats Tab
  useEffect(() => {
    if (operatorView !== 'stats') return;
    let isMounted = true;
    async function loadStats() {
      setLoading(true);
      try {
        const res = await fetchCABotAutomationStats({
          caEmail: sessionCaEmail,
          dateStr: activeWorkDate || date,
        });

        if (!isMounted) return;
        if (res.success) {
          setBotAutomationStats(res);
        }
      } catch (err) {
        console.error('Error loading CA bot automation stats:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadStats();
    const intervalId = setInterval(loadStats, 5000);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [operatorView, sessionCaEmail, activeWorkDate, date]);

  // Overall counts for this CA in this period (Strictly verified submissions with screenshot proof)
  const totals = useMemo(() => {
    const hasProof = (a) => Boolean(a.screenshot_url || a.screenshot_path || a.failure_screenshot_url);
    const currentTotal = applications.length;
    const currentSubmitted = applications.filter((a) => (a.status === 'submitted' || a.status === 'completed') && hasProof(a)).length;
    const currentFailed = applications.filter((a) => a.status === 'failed').length;
    const totalCandidatesApps = candidates.reduce((acc, c) => acc + (Number(c.jobs_applied) || 0), 0);
    return {
      total: Math.max(totalCandidatesApps, currentTotal),
      submitted: currentSubmitted,
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
            <span style={{ color: '#94a3b8' }}>WORK DATA:</span>
            <strong style={{ color: '#38bdf8', fontFamily: 'monospace' }}>{activeWorkDate} (Yesterday)</strong>
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

      {/* STATS VIEW: Real-time Playwright Bot Automation & Queue Breakdown */}
      {operatorView === 'stats' ? (
        <div className="tab-body-fade width-full" style={{ padding: '1.5rem' }}>
          <div className="operator-stats-view">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 className="stats-heading" style={{ margin: 0, fontSize: '1.35rem', color: '#f8fafc' }}>
                  Career Associate Live Bot Automation Stats
                </h2>
                <p className="stats-sub" style={{ color: '#94a3b8', margin: '0.35rem 0 0 0', fontSize: '0.85rem' }}>
                  Real-time Playwright bot execution and queue state for candidates assigned to <strong>{sessionCaEmail}</strong>.
                </p>
              </div>
              <span style={{ fontSize: '0.75rem', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.25)', padding: '4px 10px', borderRadius: '4px', fontWeight: 'bold' }}>
                ⚡ Live Polling Every 5s
              </span>
            </div>

            <div className="video-admin-kpi-grid" style={{ marginTop: '1.25rem' }}>
              <div className="video-kpi-box">
                <span className="vkpi-label">TOTAL QUEUE TASKS</span>
                <span className="vkpi-val">{botAutomationStats.totals.total}</span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label">IN QUEUE</span>
                <span className="vkpi-val">{botAutomationStats.totals.queued}</span>
              </div>
              <div className="video-kpi-box" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }}>
                <span className="vkpi-label" style={{ color: '#38bdf8' }}>BOT FILLING IN BACKGROUND</span>
                <span className="vkpi-val" style={{ color: '#38bdf8' }}>{botAutomationStats.totals.inFlight}</span>
              </div>
              <div className="video-kpi-box" style={{ borderColor: 'rgba(245, 158, 11, 0.4)' }}>
                <span className="vkpi-label" style={{ color: '#f59e0b' }}>READY TO REVIEW & SUBMIT</span>
                <span className="vkpi-val" style={{ color: '#f59e0b' }}>{botAutomationStats.totals.readyForReview}</span>
              </div>
              <div className="video-kpi-box highlighted" style={{ borderColor: 'rgba(16, 185, 129, 0.5)' }}>
                <span className="vkpi-label" style={{ color: '#34d399' }}>VERIFIED SUBMISSIONS (PROOF)</span>
                <span className="vkpi-val" style={{ color: '#34d399' }}>{botAutomationStats.totals.submitted}</span>
              </div>
              <div className="video-kpi-box">
                <span className="vkpi-label" style={{ color: '#fca5a5' }}>FAILED / BLOCKED</span>
                <span className="vkpi-val" style={{ color: '#fca5a5' }}>{botAutomationStats.totals.failed}</span>
              </div>
            </div>

            <div className="video-table-container" style={{ marginTop: '1.5rem' }}>
              <table className="video-data-table">
                <thead>
                  <tr>
                    <th>CLIENT NAME</th>
                    <th>APPLYWIZZ ID</th>
                    <th style={{ textAlign: 'center' }}>TOTAL JOBS</th>
                    <th style={{ textAlign: 'center' }}>IN QUEUE</th>
                    <th style={{ textAlign: 'center' }}>BOT FILLING</th>
                    <th style={{ textAlign: 'center' }}>READY TO REVIEW</th>
                    <th style={{ textAlign: 'center' }}>VERIFIED SUBMISSIONS</th>
                    <th>BOT STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {botAutomationStats.clientStats?.length > 0 ? (
                    botAutomationStats.clientStats.map((cs) => (
                      <tr key={cs.id}>
                        <td><strong>{cs.name}</strong></td>
                        <td><span className="app-id-tag">{cs.id}</span></td>
                        <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{cs.totalJobs}</td>
                        <td style={{ textAlign: 'center', color: '#94a3b8' }}>{cs.queued}</td>
                        <td style={{ textAlign: 'center', color: cs.inFlight > 0 ? '#38bdf8' : '#64748b', fontWeight: cs.inFlight > 0 ? 'bold' : 'normal' }}>
                          {cs.inFlight}
                        </td>
                        <td style={{ textAlign: 'center', color: cs.readyForReview > 0 ? '#f59e0b' : '#64748b', fontWeight: cs.readyForReview > 0 ? 'bold' : 'normal' }}>
                          {cs.readyForReview}
                        </td>
                        <td style={{ textAlign: 'center', color: cs.submitted > 0 ? '#34d399' : '#64748b', fontWeight: cs.submitted > 0 ? 'bold' : 'normal' }}>
                          {cs.submitted}
                        </td>
                        <td>
                          <span className={`video-status-tag ${cs.inFlight > 0 ? 'in_flight' : cs.readyForReview > 0 ? 'ready_for_review' : cs.submitted > 0 ? 'submitted' : 'queued'}`}>
                            {cs.botState}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                        No candidate queue tasks found for {sessionCaEmail} on this date.
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
                  <span
                    className="shb-badge"
                    style={{
                      background: totalCaApplications > 0 ? 'rgba(56, 189, 248, 0.15)' : 'rgba(100, 116, 139, 0.2)',
                      color: totalCaApplications > 0 ? '#38bdf8' : '#94a3b8',
                      border: `1px solid ${totalCaApplications > 0 ? 'rgba(56, 189, 248, 0.35)' : 'rgba(100, 116, 139, 0.35)'}`,
                      fontWeight: totalCaApplications > 0 ? 'bold' : 'normal',
                    }}
                  >
                    {totalCaApplications > 0 ? `${totalCaApplications} Apps` : '0 Apps (Bot Stopped)'}
                  </span>
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
                    <div className="cci-id-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="cci-awl">{c.id}</span>
                      <span style={{
                        fontSize: '0.72rem',
                        color: (c.jobs_applied || 0) > 0 ? '#38bdf8' : '#94a3b8',
                        fontWeight: (c.jobs_applied || 0) > 0 ? 'bold' : 'normal',
                        background: (c.jobs_applied || 0) > 0 ? 'rgba(56, 189, 248, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                        padding: '2px 7px',
                        borderRadius: '4px',
                        border: `1px solid ${(c.jobs_applied || 0) > 0 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(100, 116, 139, 0.25)'}`,
                      }}>
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
            {totalCaApplications === 0 && candidates.length > 0 && !loading && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: '8px',
                padding: '10px 16px',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '1.2rem' }}>🛑</span>
                  <div>
                    <div style={{ color: '#f87171', fontWeight: 'bold', fontSize: '0.86rem' }}>
                      Bot Triggering Stopped: 0 Applications Across All Clients
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '1px' }}>
                      All {candidates.length} assigned clients have 0 application links recorded. The automated bot is completely stopped and will not trigger.
                    </div>
                  </div>
                </div>
                <span style={{
                  background: 'rgba(239, 68, 68, 0.18)',
                  color: '#fca5a5',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '0.72rem',
                  fontWeight: 'bold',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  whiteSpace: 'nowrap'
                }}>
                  BOT IDLE (0 APPS)
                </span>
              </div>
            )}

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
                  </div>

                  <div className="video-table-container">
                    <table className="video-data-table">
                      <thead>
                        <tr>
                          <th>JOB TITLE & LINK</th>
                          <th>COMPANY</th>
                          <th>ATS</th>
                          <th>STATUS</th>
                          <th style={{ textAlign: 'center' }}>SCREENSHOT</th>
                          <th>ACTION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const displayableApps = applications.filter((app) => {
                            const raw = (app.status || '').toLowerCase().trim();
                            return raw === 'ready_for_review' || raw === 'ready_to_review';
                          });

                          return displayableApps.length > 0 ? (
                            displayableApps.map((app) => {
                              const rawStatus = (app.status || '').toLowerCase();
                              const proofShot = app.application_submitted_screenshot_url || app.screenshot_url || app.applied_screenshot || app.screenshot_path || null;
                              const isSubmitted = rawStatus === 'submitted' || rawStatus === 'completed';
                              const isApplying = rawStatus === 'applying' || rawStatus === 'in_flight';
                              const isReady = !isSubmitted && !isApplying;

                              const jobUrl = app.job_url || app.url || '';
                              const displayTitle = app.role_title || app.job_title || (app.company ? `${app.company} Workday Application` : 'Workday Application');

                              return (
                                <tr
                                  key={app.id || app.distributionId}
                                  style={{ background: selectedApp?.id === app.id ? '#1e293b' : 'transparent', cursor: 'pointer' }}
                                  onClick={() => {
                                    handleSelectApp(app);
                                    handleOpenReview(app);
                                  }}
                                >
                                  <td>
                                    <div>
                                      <strong style={{ color: '#f1f5f9' }}>{displayTitle}</strong>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                                        {jobUrl && (
                                          <a
                                            href={jobUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            style={{ color: '#38bdf8', fontSize: '0.74rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                                            title={jobUrl}
                                          >
                                            🔗 Link ↗
                                          </a>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                  <td style={{ color: '#cbd5e1' }}>{app.company || 'Workday Tenant'}</td>
                                  <td style={{ color: '#94a3b8' }}>{app.ats || 'Workday'}</td>
                                  <td>
                                    {isSubmitted ? (
                                      <span className="video-status-tag submitted" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                                        ✓ SUBMITTED
                                      </span>
                                    ) : isApplying ? (
                                      <span className="video-status-tag in_flight" style={{ background: 'rgba(234, 179, 8, 0.15)', color: '#facc15', border: '1px solid rgba(234, 179, 8, 0.3)' }}>
                                        ⚡ APPLYING...
                                      </span>
                                    ) : (
                                      <span className="video-status-tag ready_for_review" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                                        READY TO REVIEW
                                      </span>
                                    )}
                                  </td>
                                  <td style={{ textAlign: 'center' }}>
                                    {isSubmitted && proofShot ? (
                                      <a
                                        href={proofShot}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        style={{
                                          padding: '4px 9px',
                                          borderRadius: '4px',
                                          fontSize: '0.74rem',
                                          fontWeight: 'bold',
                                          textDecoration: 'none',
                                          background: 'rgba(16, 185, 129, 0.15)',
                                          color: '#34d399',
                                          border: '1px solid rgba(16, 185, 129, 0.3)',
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: '4px',
                                        }}
                                        title="Click to view genuine Playwright submission screenshot"
                                      >
                                        📸 View Proof ↗
                                      </a>
                                    ) : (
                                      <span style={{ fontSize: '0.8rem', color: '#475569' }}>—</span>
                                    )}
                                  </td>
                                  <td>
                                    {isSubmitted ? (
                                      <span
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: '4px',
                                          fontSize: '0.78rem',
                                          color: '#34d399',
                                          fontWeight: 'bold',
                                          background: 'rgba(16, 185, 129, 0.12)',
                                          border: '1px solid rgba(16, 185, 129, 0.3)',
                                          padding: '4px 10px',
                                          borderRadius: '4px',
                                        }}
                                      >
                                        ✓ Submitted
                                      </span>
                                    ) : isApplying ? (
                                      <span
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: '6px',
                                          fontSize: '0.78rem',
                                          color: '#facc15',
                                          fontWeight: 'bold',
                                          background: 'rgba(234, 179, 8, 0.1)',
                                          border: '1px solid rgba(234, 179, 8, 0.3)',
                                          padding: '4px 10px',
                                          borderRadius: '4px',
                                        }}
                                      >
                                        ⚡ In Progress...
                                      </span>
                                    ) : (
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
                                        📋 Review & Submit
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })
                          ) : (
                            <tr>
                              <td colSpan={6} style={{ textAlign: 'center', padding: '2.5rem', color: '#94a3b8' }}>
                                <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#cbd5e1' }}>
                                  No applications ready for review in job_distributions for {selectedCandidate?.id || 'this candidate'}.
                                </div>
                                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.35rem' }}>
                                  Only applications with pre-resolved answers in job_distributions are assigned to CA queue.
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                      </tbody>
                    </table>
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

      {/* Interactive Form Review Slide Drawer */}
      <ApplicationSlideDrawer
        isOpen={showReviewModal}
        onClose={() => {
          setShowReviewModal(false);
          setReviewTargetApp(null);
        }}
        application={reviewTargetApp ? {
          ...reviewTargetApp,
          applywizz_id: selectedCandidate?.id || reviewTargetApp.applywizz_id,
          job_url: reviewTargetApp.job_url || reviewTargetApp.url || '',
          company: reviewTargetApp.company || '',
          job_title: reviewTargetApp.job_title || reviewTargetApp.role_title || '',
        } : null}
        onStatusUpdated={({ status }) => {
          handleReviewSubmitted({
            applywizzId: selectedCandidate?.id || reviewTargetApp?.applywizz_id,
            jobUrl: reviewTargetApp?.job_url || reviewTargetApp?.url,
          });
        }}
      />
    </div>
  );
}
