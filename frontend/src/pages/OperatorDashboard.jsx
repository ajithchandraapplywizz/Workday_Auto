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
} from '../services/api';
import ApplicationFormReviewModal from '../components/ApplicationFormReviewModal';

export default function OperatorDashboard({ operatorView = 'dashboard' }) {
  const { user, date, timeframe } = useAuth();

  // Active CA identity (strictly scoped to logged-in operator session)
  const [caRoster, setCaRoster] = useState([]);
  const [sessionCaEmail, setSessionCaEmail] = useState(
    user?.email && user?.email.includes('@') ? user.email.toLowerCase().trim() : 'manasa@applywizz.com'
  );
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');

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
  const loadAssignedClients = async () => {
    setLoading(true);
    try {
      const res = await fetchAssignedClientsForCA({
        caEmail: sessionCaEmail,
        atDate: date,
      });

      setActiveWorkDate(res.activeDate || date);
      setIsFallbackDate(Boolean(res.isFallback));

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
        const fbTag = res.isFallback ? ' (Fallback)' : '';
        setSyncMessage(`Synced ${res.count} clients for ${res.activeDate}${fbTag}`);
        await loadAssignedClients();
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
    const total = applications.length;
    const submitted = applications.filter((a) => a.status === 'submitted').length;
    const failed = applications.filter((a) => a.status === 'failed').length;
    return { total, submitted, failed };
  }, [applications]);

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
      {/* Top Bar with Scoped Operator Identity */}
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
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>0 Apps</span>
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
                      <div>Work Email: <strong style={{ color: '#38bdf8' }}>{clientDetails?.company_email || '—'}</strong></div>
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
                    <button
                      type="button"
                      className="video-btn-start"
                      style={{ padding: '5px 14px', fontSize: '0.8rem', background: '#0284c7', borderColor: '#38bdf8' }}
                      onClick={() => handleOpenReview(selectedApp || { applywizz_id: selectedCandidate.id, company: 'Workday Partner', role_title: 'Workday Application' })}
                    >
                      📋 Review Application Form
                    </button>
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
                                handleOpenReview(app);
                              }}
                            >
                              <td>
                                <strong>{app.job_title || app.role_title || 'Workday Position'}</strong>
                              </td>
                              <td>{app.company || 'Workday Tenant'}</td>
                              <td>{app.ats || 'Workday'}</td>
                              <td>
                                {app.status === 'failed' ? (
                                  <span className="video-status-tag failed" title={app.failure_reason}>
                                    Failed – {app.error_category || app.failure_reason || 'Unknown error'}
                                  </span>
                                ) : (
                                  <span className={`video-status-tag ${app.status?.toLowerCase() || 'ready_for_review'}`}>
                                    {app.status?.toUpperCase() || 'READY_FOR_REVIEW'}
                                  </span>
                                )}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="video-btn-start"
                                  style={{
                                    padding: '4px 12px',
                                    fontSize: '0.8rem',
                                    background: app.status === 'submitted' ? '#065f46' : '#0284c7',
                                    borderColor: app.status === 'submitted' ? '#10b981' : '#38bdf8'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSelectApp(app);
                                    handleOpenReview(app);
                                  }}
                                >
                                  {app.status === 'submitted' ? 'View Submitted Form' : 'Review & Confirm'}
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                              <div style={{ fontWeight: 'bold' }}>No applications recorded yet in database for {selectedCandidate.id}.</div>
                              <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.25rem', marginBottom: '0.75rem' }}>
                                Ready for Workday batch CSV submission / queue worker run.
                              </div>
                              <button
                                type="button"
                                className="video-btn-start"
                                style={{ padding: '6px 14px', fontSize: '0.82rem', background: '#1e293b', borderColor: '#38bdf8' }}
                                onClick={() => handleOpenReview({ applywizz_id: selectedCandidate.id, company: 'Workday Partner', role_title: 'Workday Application' })}
                              >
                                📋 Inspect Pre-filled Form Answers for {selectedCandidate.id}
                              </button>
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
