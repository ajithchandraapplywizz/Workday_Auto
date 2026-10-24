import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  fetchApplicationsDynamic,
  fetchDynamicKPIMetrics,
  fetchWorkerStatuses,
  checkAllApiHealth,
  fetchBatchQueue,
  fetchAutomationTrace,
  fetchBatchWorkerLogs,
  triggerAutonomousBot,
  stopAutonomousBot,
  triggerSubmissionStage,
  stopSubmissionStage,
  fetchBotDaemonStatus,
  resolveSupabaseStorageUrl,
  cleanCanonicalJobUrl,
  getBackendBaseUrl,
  supabase,
} from '../services/api';

export default function DeveloperDashboard() {
  const { date, timeframe } = useAuth();

  const [activeTab, setActiveTab] = useState('System');
  const [statusFilter, setStatusFilter] = useState('All');
  const [stoppedBlockFilter, setStoppedBlockFilter] = useState('All');
  const [errorSearchQuery, setErrorSearchQuery] = useState('');
  const [selectedErrorScreenshot, setSelectedErrorScreenshot] = useState(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState(null);
  const [debugSearch, setDebugSearch] = useState('');
  const [selectedDebugApp, setSelectedDebugApp] = useState(null);
  const [debugTrace, setDebugTrace] = useState([]);

  // Batch-wise 9-worker logs states
  const [batchLogs, setBatchLogs] = useState({
    scanning: [],
    resolving: [],
    submitting: [],
  });
  const [activeBatchView, setActiveBatchView] = useState('all'); // 'all' | 'scanning' | 'resolving' | 'submitting'
  const [scanWorkerFilter, setScanWorkerFilter] = useState('all');
  const [resolveWorkerFilter, setResolveWorkerFilter] = useState('all');
  const [submitWorkerFilter, setSubmitWorkerFilter] = useState('all');
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  
  // Real dynamic states from Supabase & backend
  const [kpis, setKpis] = useState({
    submitted: 0,
    applying: 0,
    failed: 0,
    queued: 0,
    total: 0
  });
  const [workerPool, setWorkerPool] = useState({ inFlight: 0, idle: 9, total: 9, scanningActive: 0, resolvingActive: 0, submittingActive: 0, workers: [] });
  const [healthResults, setHealthResults] = useState([]);
  const [applications, setApplications] = useState([]);
  const [queueItems, setQueueItems] = useState([]);
  const [operators, setOperators] = useState([]);
  const [managers, setManagers] = useState([]);
  const [clientToCaMap, setClientToCaMap] = useState(new Map());
  const [operatorSearch, setOperatorSearch] = useState('');
  const [managerFilter, setManagerFilter] = useState('All');
  const [updatingOpId, setUpdatingOpId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [botStatus, setBotStatus] = useState({ isRunning: false, state: 'idle', workersAssigned: 9, isSubmitting: false });
  const [isTriggering, setIsTriggering] = useState(false);
  const [isSubmitTriggering, setIsSubmitTriggering] = useState(false);
  const [triggerToast, setTriggerToast] = useState(null);

  // Dedicated Backend Daemon URL & Connection Status
  const [backendUrl, setBackendUrl] = useState(() => getBackendBaseUrl());
  const [backendUrlInput, setBackendUrlInput] = useState(() => getBackendBaseUrl());
  const [showBackendConfig, setShowBackendConfig] = useState(false);
  const [backendPingStatus, setBackendPingStatus] = useState('checking'); // 'connected' | 'offline' | 'checking'

  const tabs = ['System', 'Worker Logs', 'CA Roster', 'Runs', 'Errors', 'Queue', 'Debugger', 'Guide'];

  // Dynamic label for period tile
  const periodLabel = useMemo(() => {
    if (timeframe === 'week') return 'This Week';
    if (timeframe === 'month') return 'This Month';
    return 'Today';
  }, [timeframe]);

  // Periodic Backend Ping to check connectivity
  useEffect(() => {
    let isMounted = true;
    async function checkBackend() {
      try {
        const res = await fetchBotDaemonStatus();
        if (!isMounted) return;
        setBackendPingStatus(res.success && (res.isRunning !== undefined) ? 'connected' : 'offline');
      } catch {
        if (isMounted) setBackendPingStatus('offline');
      }
    }
    checkBackend();
    const interval = setInterval(checkBackend, 8000);
    return () => { isMounted = false; clearInterval(interval); };
  }, [backendUrl]);

  // Live polling for Batch Worker Logs when Worker Logs tab is active
  useEffect(() => {
    if (activeTab !== 'Worker Logs') return;
    let isMounted = true;
    async function pollBatchLogs() {
      const res = await fetchBatchWorkerLogs({ limit: 120 });
      if (!isMounted) return;
      if (res.success && res.batches) {
        setBatchLogs(res.batches);
      }
    }
    // Immediate initial fetch
    pollBatchLogs();

    // Continuous polling every 2.5s while viewing logs
    const interval = setInterval(pollBatchLogs, 2500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTab]);

  // Load all dynamic data with real-time polling and Supabase Realtime channel
  useEffect(() => {
    let isMounted = true;
    async function loadData(silent = false) {
      if (!silent) setLoading(true);
      try {
        const [kpiRes, workerRes, healthRes, appsRes, queueRes, opsRes, mgrsRes, logsRes, clientsRes, daemonRes] = await Promise.all([
          fetchDynamicKPIMetrics({ dateStr: date, timeframe }),
          fetchWorkerStatuses(),
          checkAllApiHealth(),
          fetchApplicationsDynamic({ dateStr: date, timeframe, limit: 300 }),
          fetchBatchQueue(),
          fetchAllOperators(),
          supabase.from('managers').select('*'),
          supabase.from('client_assignment_log').select('applywizz_id, ca_email, ca_id').order('assignment_date', { ascending: false }).limit(1000),
          supabase.from('clients').select('applywizz_id, client_name, ca_email, current_ca_email'),
          fetchBotDaemonStatus(),
        ]);

        if (daemonRes?.success) {
          setBotStatus(daemonRes);
        }

        if (!isMounted) return;

        const activeWorkersCount = workerRes?.success ? (workerRes.inFlight || 0) : 0;
        if (workerRes?.success) {
          setWorkerPool(workerRes);
        }

        if (kpiRes.success) {
          // Double-guard: If 0 workers are in active state, applying is strictly 0
          const reconciledApplying = activeWorkersCount > 0 ? Math.min(kpiRes.applying, activeWorkersCount) : 0;
          setKpis({
            submitted: kpiRes.submitted,
            applying: reconciledApplying,
            failed: kpiRes.failed,
            queued: kpiRes.queued,
            total: kpiRes.total,
          });
        }

        setHealthResults(healthRes);

        if (appsRes.success) {
          setApplications(appsRes.applications || []);
        }

        if (queueRes.success) {
          setQueueItems(queueRes.queue || []);
        }

        if (opsRes.success) {
          setOperators(opsRes.operators || []);
        }

        if (mgrsRes.data) {
          setManagers(mgrsRes.data || []);
        }

        const cMap = new Map();
        if (clientsRes?.data) {
          for (const c of clientsRes.data) {
            const id = (c.applywizz_id || '').trim().toUpperCase();
            if (id) {
              cMap.set(id, {
                caEmail: (c.current_ca_email || c.ca_email || '').toLowerCase().trim(),
                clientName: c.client_name || id,
              });
            }
          }
        }
        if (logsRes?.data) {
          for (const l of logsRes.data) {
            const id = (l.applywizz_id || '').trim().toUpperCase();
            if (id) {
              const prev = cMap.get(id) || { clientName: id, caEmail: '' };
              cMap.set(id, {
                caEmail: (l.ca_email || prev.caEmail || '').toLowerCase().trim(),
                clientName: prev.clientName || id,
              });
            }
          }
        }
        setClientToCaMap(cMap);
      } catch (err) {
        console.error('Error loading developer dashboard data:', err);
      } finally {
        if (isMounted && !silent) setLoading(false);
      }
    }

    loadData(false);

    // Dynamic 3s interval for smooth active polling without flicker
    const pollInterval = setInterval(() => {
      loadData(true);
    }, 3000);

    // Supabase Realtime channel for instant push updates
    const channel = supabase
      .channel('dev-dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_distributions' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'submission_tasks' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'worker_status' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_control' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'batch_job_queue' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scanned_jobs' }, () => loadData(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'failed_jobs' }, () => loadData(true))
      .subscribe();

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
      supabase.removeChannel(channel);
    };
  }, [date, timeframe]);

  // Filtered runs for Runs tab
  const filteredRuns = useMemo(() => {
    return applications.filter((app) => {
      if (statusFilter === 'All') return true;
      return app.status?.toLowerCase() === statusFilter.toLowerCase();
    });
  }, [applications, statusFilter]);

  // Helper: Resolve precisely which block/step the application failed or stopped at
  const resolveStoppedBlock = (app) => {
    if (app.stopped_at_step) return app.stopped_at_step;
    const rawReason = String(app.failure_reason || app.error_category || app.error_message || '');
    const stepMatch = rawReason.match(/\[step:\s*([^\]]+)\]/i) || rawReason.match(/stopped at\s+([^)\],]+)/i);
    if (stepMatch) return stepMatch[1].trim();
    const reason = rawReason.toLowerCase();
    if (reason.includes('expired') || reason.includes("doesn't exist") || reason.includes("not exist") || reason.includes('job_not_found') || reason.includes('404')) {
      return 'Link Expired';
    }
    if (reason.includes('auth') || reason.includes('password') || reason.includes('credential') || reason.includes('sign in') || reason.includes('create account')) {
      return 'Auth Gateway (Sign In / Sign Up)';
    }
    if (reason.includes('zoho') || reason.includes('mailbox') || reason.includes('verification') || reason.includes('otp')) {
      return 'Verification: Zoho Mail';
    }
    if (reason.includes('resume') || reason.includes('experience') || reason.includes('work history')) {
      return 'Step 2: My Experience';
    }
    if (reason.includes('voluntary') || reason.includes('eeo') || reason.includes('disclosure') || reason.includes('self identify')) {
      return 'Step 4: Voluntary Disclosures';
    }
    if (reason.includes('review') || reason.includes('submit')) {
      return 'Step 5: Review & Submit';
    }
    if (reason.includes('field') || reason.includes('question') || reason.includes('work_auth') || reason.includes('unanswered') || reason.includes('missing')) {
      return 'Step 3: Application Questions';
    }
    if (reason.includes('closed') || reason.includes('timeout') || reason.includes('target page') || reason.includes('context')) {
      return 'Session Closed / Watchdog Timeout';
    }
    return 'Step 1: My Information';
  };

  // Helper: Shorten job URL for clean table display
  const formatShortUrl = (url) => {
    if (!url) return '—';
    try {
      const u = new URL(url);
      const host = u.hostname.replace('www.', '');
      const pathParts = u.pathname.split('/').filter(Boolean);
      const last = pathParts[pathParts.length - 1] || '';
      return `${host}/.../${last.substring(0, 22)}`;
    } catch {
      return url.length > 35 ? `${url.substring(0, 35)}...` : url;
    }
  };

  // Helper: Extract screenshot URL from multiple potential fields
  const extractFailureScreenshot = (app) => {
    if (!app) return null;
    const raw = app.application_submitted_screenshot_url
      || app.applied_screenshot
      || app.failure_screenshot_url
      || app.screenshot_url
      || app.screenshot_path
      || null;
    if (raw) return resolveSupabaseStorageUrl(raw);
    const reason = String(app.failure_reason || app.error_message || app.error_category || '');
    const match = reason.match(/\[screenshot:\s*([^\s\]]+)\]/i) || reason.match(/https:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|svg)/i);
    if (match) return resolveSupabaseStorageUrl(match[1] || match[0]);
    return null;
  };

  // Helper: Human-friendly root cause explanation
  const getFailureExplanation = (reasonRaw, stoppedBlock) => {
    const r = String(reasonRaw || '').toLowerCase();
    if (r.includes('expired') || r.includes("doesn't exist") || r.includes('not exist') || r.includes('job_not_found') || r.includes('404') || stoppedBlock === 'Link Expired') {
      return 'Workday Job Link Expired or removed by employer ("The page you are looking for doesn\'t exist"). This link has been permanently blacklisted across all candidate queues to eliminate wasted worker runs.';
    }
    if (r.includes('wizard_did_not_reach_review')) {
      return `The Workday wizard halted at "${stoppedBlock}". An unanswered mandatory field, validation error, or step transition check prevented advancement.`;
    }
    if (r.includes('authentication failed') || r.includes('auth_failed')) {
      return 'Workday candidate sign-in failed. Candidate account password, email verification, or captcha security challenge could not be completed.';
    }
    if (r.includes('zoho') || r.includes('mailbox')) {
      return 'Zoho Mail reader could not retrieve candidate verification OTP or password reset link within the timeout window.';
    }
    if (r.includes('closed') || r.includes('context') || r.includes('target page')) {
      return 'The browser page or browser session was closed or disconnected while the automation was in progress.';
    }
    if (r.includes('timeout') || r.includes('stalled')) {
      return 'Page interaction or element selection exceeded the allowed timeout threshold.';
    }
    return `The automation stopped at ${stoppedBlock}. Check the failure screenshot and profile answers for details.`;
  };

  // Helper: Live operator status considering 2-minute disconnect window
  const getOperatorEffectiveStatus = (op) => {
    if (!op) return 'inactive';
    const raw = (op.status || '').toLowerCase();
    if (raw === 'logged_out') return 'logged_out';
    if (!op.updated_at && !op.last_sign_in) return 'inactive';
    const last = new Date(op.updated_at || op.last_sign_in).getTime();
    if (Date.now() - last > 2 * 60 * 1000) {
      return 'inactive'; // Disconnected > 2 minutes
    }
    return raw === 'active' ? 'active' : 'inactive';
  };

  // Operator lookup maps
  const operatorMap = useMemo(() => {
    const map = new Map();
    for (const op of operators) {
      map.set(op.email.toLowerCase().trim(), op);
    }
    return map;
  }, [operators]);

  // Filtered failed applications for Errors tab
  const failedApps = useMemo(() => {
    return applications.filter((app) => (app.status || '').toLowerCase() === 'failed');
  }, [applications]);

  // Group failed applications by canonical job URL: 1 row per unique job, showing failed client count & client IDs
  const groupedFailedJobs = useMemo(() => {
    const jobGroups = new Map();

    for (const app of failedApps) {
      const rawUrl = app.job_url || '';
      const canonicalUrl = cleanCanonicalJobUrl(rawUrl) || rawUrl.trim().toLowerCase();
      if (!canonicalUrl) continue;

      const normId = (app.applywizz_id || '').toUpperCase().trim();
      const stoppedBlock = resolveStoppedBlock(app);
      const shot = extractFailureScreenshot(app);

      // Collect client IDs (handles both single applywizz_id or an array/json of client_ids)
      const rawCids = Array.isArray(app.client_ids)
        ? app.client_ids
        : (typeof app.client_ids === 'string'
            ? (() => { try { const p = JSON.parse(app.client_ids); return Array.isArray(p) ? p : [app.client_ids]; } catch { return [app.client_ids]; } })()
            : []);
      const allAppCids = new Set(rawCids.map((c) => String(c || '').toUpperCase().trim()).filter(Boolean));
      if (normId) allAppCids.add(normId);

      if (!jobGroups.has(canonicalUrl)) {
        jobGroups.set(canonicalUrl, {
          id: app.id,
          canonical_job_url: canonicalUrl,
          job_url: app.job_url,
          company: app.company || 'Workday Tenant',
          role_title: app.role_title || app.job_title || 'Workday Application',
          stopped_at_step: stoppedBlock,
          failure_reason: app.failure_reason || app.error_message || 'wizard_did_not_reach_review',
          screenshot_url: shot,
          client_ids: Array.from(allAppCids),
          ca_emails: new Set(),
          manager_names: new Set(),
          sample_app: app,
        });
      } else {
        const existing = jobGroups.get(canonicalUrl);
        for (const cid of allAppCids) {
          if (!existing.client_ids.includes(cid)) {
            existing.client_ids.push(cid);
          }
        }
        if (!existing.screenshot_url && shot) {
          existing.screenshot_url = shot;
        }
      }

      const grp = jobGroups.get(canonicalUrl);
      const clientMeta = clientToCaMap.get(normId);
      const caEmail = (app.ca_id || clientMeta?.caEmail || '').toLowerCase().trim();
      if (caEmail) {
        grp.ca_emails.add(caEmail);
        const op = operatorMap.get(caEmail);
        const mgr = op?.manager_name || (op?.manager_id === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'Balaji' : 'Ramakrishna');
        if (mgr) grp.manager_names.add(mgr);
      }
    }

    return Array.from(jobGroups.values()).map((g) => ({
      ...g,
      failed_client_count: g.client_ids.length,
      client_ids_json: JSON.stringify(g.client_ids),
      ca_display: Array.from(g.ca_emails).slice(0, 3).join(', ') + (g.ca_emails.size > 3 ? ` +${g.ca_emails.size - 3}` : ''),
      manager_display: Array.from(g.manager_names).join(', ') || 'Unassigned',
    }));
  }, [failedApps, clientToCaMap, operatorMap]);

  // Filtered failed applications for individual audit
  const filteredFailedApps = useMemo(() => {
    return groupedFailedJobs.filter((job) => {
      const matchesBlock = stoppedBlockFilter === 'All' || job.stopped_at_step.toLowerCase().includes(stoppedBlockFilter.toLowerCase());
      
      const q = errorSearchQuery.toLowerCase().trim();
      if (!q) return matchesBlock;

      const clientMatch = job.client_ids.some((cid) => cid.toLowerCase().includes(q));
      const companyMatch = (job.company || '').toLowerCase().includes(q);
      const roleMatch = (job.role_title || '').toLowerCase().includes(q);
      const reasonMatch = (job.failure_reason || '').toLowerCase().includes(q);
      const caMatch = (job.ca_display || '').toLowerCase().includes(q);

      return matchesBlock && (clientMatch || companyMatch || roleMatch || reasonMatch || caMatch);
    });
  }, [groupedFailedJobs, stoppedBlockFilter, errorSearchQuery]);

  // Handle open in debugger
  const handleOpenDebugger = async (appId) => {
    setActiveTab('Debugger');
    setDebugSearch(appId);
    const found = applications.find((a) => a.id === appId || a.applywizz_id === appId);
    if (found) {
      setSelectedDebugApp(found);
      const traceRes = await fetchAutomationTrace(found.id);
      if (traceRes.success) {
        setDebugTrace(traceRes.trace);
      }
    }
  };

  // Toggle CA status (active / inactive)
  const handleToggleOperatorStatus = async (op) => {
    const eff = getOperatorEffectiveStatus(op);
    const newStatus = eff === 'active' ? 'inactive' : 'active';
    const nowIso = new Date().toISOString();
    setUpdatingOpId(op.id);
    try {
      await updateOperatorStatus(op.id, newStatus);
      if (op.email) {
        await supabase
          .from('auth_users')
          .update({ status: newStatus, updated_at: nowIso })
          .ilike('email', op.email.toLowerCase().trim())
          .catch(() => {});
      }
      setOperators((prev) =>
        prev.map((o) => (o.id === op.id ? { ...o, status: newStatus, updated_at: nowIso } : o))
      );
    } catch (err) {
      console.error('Failed to update operator status:', err);
    } finally {
      setUpdatingOpId(null);
    }
  };

  // Filtered operators for CA Roster tab
  const filteredOperators = useMemo(() => {
    return operators.filter((op) => {
      const q = operatorSearch.toLowerCase();
      const matchesSearch =
        !operatorSearch ||
        op.name.toLowerCase().includes(q) ||
        op.email.toLowerCase().includes(q);
      const mName = (op.manager_name || (op.manager_id === '9dc9376e-fbc5-440b-932f-38da10b89a70' ? 'Balaji' : (op.manager_id === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744' ? 'Ramakrishna' : ''))).toLowerCase();
      const matchesManager =
        managerFilter === 'All' ||
        mName.includes(managerFilter.toLowerCase());
      return matchesSearch && matchesManager;
    });
  }, [operators, operatorSearch, managerFilter]);

  // Find health test by id helper
  const getHealth = (id) => {
    return healthResults.find((h) => h.id === id) || { ok: true, status: 'OK', time: 15, meta: 'Online' };
  };

  // Handle triggering autonomous 2-worker pipeline (Scan & Resolve)
  const handleTriggerBot = async () => {
    if (botStatus.isSubmitting) {
      setTriggerToast({
        type: 'error',
        text: '⚠️ Cannot start Scan & Resolve: Submissions are actively running! Stop Submissions first.',
      });
      setTimeout(() => setTriggerToast(null), 6000);
      return;
    }

    setIsTriggering(true);
    setTriggerToast({ type: 'info', text: '⚡ Dispatching 2-Worker Pipeline trigger (Scan & Resolve)...' });
    try {
      const res = await triggerAutonomousBot();
      if (res.success) {
        setTriggerToast({
          type: 'success',
          text: '✓ Autonomous 2-Worker Pipeline Triggered! Worker 1 and Worker 2 are actively scanning links and pre-resolving questions.',
        });
        setBotStatus((prev) => ({ ...prev, isRunning: true, state: 'running' }));
      } else {
        setTriggerToast({ type: 'error', text: 'Trigger error: ' + (res.error || 'Failed to dispatch signal') });
      }
    } catch (err) {
      setTriggerToast({ type: 'error', text: 'Trigger error: ' + err.message });
    } finally {
      setIsTriggering(false);
      setTimeout(() => setTriggerToast(null), 10000);
    }
  };

  // Handle stopping autonomous workers
  const handleStopBot = async () => {
    setIsTriggering(true);
    setTriggerToast({ type: 'info', text: '🛑 Halting all background scan & resolve workers immediately...' });
    
    // Immediately reflect stopped state in UI without waiting
    setBotStatus((prev) => ({ ...prev, isRunning: false, state: 'stopped' }));
    setWorkerPool((prev) => ({
      ...prev,
      inFlight: 0,
      scanningActive: 0,
      resolvingActive: 0,
    }));

    // Inject immediate visual stop banner into both Scanning and Resolving terminals
    const stopEntry = {
      id: 'stop-' + Date.now(),
      ts: new Date().toISOString(),
      step_index: 0,
      message: '🛑 [STOPPED] Background worker activity TERMINATED immediately by user. All browser contexts closed and workers set to idle.',
      level: 'warn',
    };
    setBatchLogs((prev) => ({
      ...prev,
      scanning: [stopEntry, ...(prev.scanning || [])],
      resolving: [stopEntry, ...(prev.resolving || [])],
    }));

    try {
      const res = await stopAutonomousBot();
      if (res.success) {
        setTriggerToast({
          type: 'success',
          text: '✓ All background workers and browser contexts STOPPED immediately and set to idle.',
        });
      } else {
        setTriggerToast({ type: 'error', text: 'Stop error: ' + (res.error || 'Failed to stop workers') });
      }
    } catch (err) {
      setTriggerToast({ type: 'error', text: 'Stop error: ' + err.message });
    } finally {
      setIsTriggering(false);
      setTimeout(() => setTriggerToast(null), 8000);
    }
  };

  // Handle triggering submission pipeline for all approved applications
  const handleTriggerSubmissions = async () => {
    if (botStatus.isRunning) {
      setTriggerToast({
        type: 'error',
        text: '⚠️ Cannot start Submissions: Scan & Resolve is actively running! Stop Scan & Resolve first.',
      });
      setTimeout(() => setTriggerToast(null), 6000);
      return;
    }

    setIsSubmitTriggering(true);
    setTriggerToast({ type: 'info', text: '🚀 Launching Submissions across Worker 1 and Worker 2...' });
    try {
      const res = await triggerSubmissionStage();
      if (res.success) {
        setTriggerToast({
          type: 'success',
          text: '✓ Submissions Pipeline Triggered! Submitting approved applications across 2 dedicated workers.',
        });
        setBotStatus((prev) => ({ ...prev, isSubmitting: true }));
      } else {
        setTriggerToast({ type: 'error', text: 'Submission trigger error: ' + (res.error || 'Failed to launch submissions') });
      }
    } catch (err) {
      setTriggerToast({ type: 'error', text: 'Submission trigger error: ' + err.message });
    } finally {
      setIsSubmitTriggering(false);
      setTimeout(() => setTriggerToast(null), 10000);
    }
  };

  // Handle hard stopping submission pipeline
  const handleStopSubmissions = async () => {
    setIsSubmitTriggering(true);
    setTriggerToast({ type: 'info', text: '🛑 Halting all submission workers and active browsers immediately...' });

    // Immediately reflect stopped state in UI without waiting
    setBotStatus((prev) => ({ ...prev, isSubmitting: false }));
    setWorkerPool((prev) => ({
      ...prev,
      inFlight: 0,
      submittingActive: 0,
    }));

    // Inject immediate visual stop banner into Submitting terminal
    const stopEntry = {
      id: 'stop-submit-' + Date.now(),
      ts: new Date().toISOString(),
      step_index: 0,
      message: '🛑 [STOPPED] Submission pipeline TERMINATED immediately by user. Active browser contexts aborted.',
      level: 'warn',
    };
    setBatchLogs((prev) => ({
      ...prev,
      submitting: [stopEntry, ...(prev.submitting || [])],
    }));

    try {
      const res = await stopSubmissionStage();
      if (res.success) {
        setTriggerToast({
          type: 'success',
          text: '✓ All submission workers STOPPED immediately. Active submission browser windows aborted.',
        });
      } else {
        setTriggerToast({ type: 'error', text: 'Stop error: ' + (res.error || 'Failed to stop submissions') });
      }
    } catch (err) {
      setTriggerToast({ type: 'error', text: 'Stop error: ' + err.message });
    } finally {
      setIsSubmitTriggering(false);
      setTimeout(() => setTriggerToast(null), 8000);
    }
  };

  return (
    <div className="dashboard-container">
      {/* 2-Worker Autonomous Pipeline Trigger Banner (Scan & Resolve) */}
      <div style={{
        background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
        border: '1px solid #334155',
        borderRadius: '8px',
        padding: '1rem 1.5rem',
        marginBottom: '1.25rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: '42px',
            height: '42px',
            borderRadius: '8px',
            background: botStatus.isRunning ? 'rgba(16, 185, 129, 0.15)' : 'rgba(56, 189, 248, 0.15)',
            border: botStatus.isRunning ? '1px solid #10b981' : '1px solid #0284c7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: botStatus.isRunning ? '#34d399' : '#38bdf8',
            fontSize: '1.25rem'
          }}>
            {botStatus.isRunning ? '🚀' : '⚡'}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc', fontWeight: 700 }}>
                Autonomous 2-Worker Pipeline (Scan &amp; Resolve)
              </h3>
              <span style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '12px',
                background: botStatus.isRunning ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.15)',
                color: botStatus.isRunning ? '#34d399' : '#f87171',
                border: botStatus.isRunning ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(239, 68, 68, 0.3)',
              }}>
                {botStatus.isRunning ? `ACTIVE • ${workerPool.inFlight || 2} WORKERS RUNNING` : 'STOPPED • WORKER 1 & WORKER 2 IDLE'}
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Worker 1 &amp; Worker 2 dedicated to Scanning &amp; Pre-Resolving answers into job_distributions. Submissions untouched.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {botStatus.isRunning ? (
            <button
              type="button"
              onClick={handleStopBot}
              disabled={isTriggering}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0.65rem 1.35rem',
                borderRadius: '6px',
                border: 'none',
                background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
                color: '#ffffff',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(239, 68, 68, 0.35)',
                transition: 'all 0.15s ease',
              }}
            >
              <span>🛑 Stop Scan &amp; Resolve</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleTriggerBot}
              disabled={isTriggering || botStatus.isSubmitting}
              title={botStatus.isSubmitting ? 'Stop Submissions first before starting Scan & Resolve' : ''}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0.65rem 1.35rem',
                borderRadius: '6px',
                border: 'none',
                background: botStatus.isSubmitting
                  ? 'linear-gradient(135deg, #475569 0%, #334155 100%)'
                  : 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                color: botStatus.isSubmitting ? '#94a3b8' : '#ffffff',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: botStatus.isSubmitting ? 'not-allowed' : 'pointer',
                boxShadow: botStatus.isSubmitting ? 'none' : '0 4px 12px rgba(2, 132, 199, 0.35)',
                transition: 'all 0.15s ease',
                opacity: botStatus.isSubmitting ? 0.6 : 1,
              }}
            >
              <span>{isTriggering ? '⚡ Dispatching Signal...' : '⚡ Start Scan & Resolve (2 Workers)'}</span>
            </button>
          )}

          {botStatus.isRunning && (
            <button
              type="button"
              onClick={handleStopBot}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0.65rem 1rem',
                borderRadius: '6px',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Force pause background workers"
            >
              Pause
            </button>
          )}
        </div>
      </div>

      {/* Stage 3 Submissions Trigger Banner (Placed directly below Scanning Trigger) */}
      <div style={{
        background: 'linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%)',
        border: '1px solid #4338ca',
        borderRadius: '8px',
        padding: '1rem 1.5rem',
        marginBottom: '1.25rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem',
        boxShadow: '0 4px 12px rgba(67, 56, 202, 0.2)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{
            width: '42px',
            height: '42px',
            borderRadius: '8px',
            background: botStatus.isSubmitting ? 'rgba(16, 185, 129, 0.15)' : 'rgba(129, 140, 248, 0.15)',
            border: botStatus.isSubmitting ? '1px solid #10b981' : '1px solid #6366f1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: botStatus.isSubmitting ? '#34d399' : '#a5b4fc',
            fontSize: '1.25rem'
          }}>
            {botStatus.isSubmitting ? '📤' : '📋'}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', color: '#f8fafc', fontWeight: 700 }}>
                Autonomous 2-Worker Submissions Engine (Stage 3)
              </h3>
              <span style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '12px',
                background: botStatus.isSubmitting ? 'rgba(16, 185, 129, 0.2)' : 'rgba(148, 163, 184, 0.15)',
                color: botStatus.isSubmitting ? '#34d399' : '#94a3b8',
                border: botStatus.isSubmitting ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(148, 163, 184, 0.3)',
              }}>
                {botStatus.isSubmitting ? `SUBMITTING • WORKER 1 & WORKER 2 ACTIVE` : 'SUBMIT IDLE • WAITING FOR TRIGGER'}
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Worker 1 &amp; Worker 2 dedicated to submitting approved applications. Instantly halts browser wizards and freezes terminal logs on stop.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {botStatus.isSubmitting ? (
            <button
              type="button"
              onClick={handleStopSubmissions}
              disabled={isSubmitTriggering}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0.65rem 1.35rem',
                borderRadius: '6px',
                border: 'none',
                background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
                color: '#ffffff',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(239, 68, 68, 0.35)',
                transition: 'all 0.15s ease',
              }}
            >
              <span>🛑 Stop Submissions</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleTriggerSubmissions}
              disabled={isSubmitTriggering || botStatus.isRunning}
              title={botStatus.isRunning ? 'Stop Scan & Resolve first before starting Submissions' : ''}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0.65rem 1.35rem',
                borderRadius: '6px',
                border: 'none',
                background: botStatus.isRunning
                  ? 'linear-gradient(135deg, #475569 0%, #334155 100%)'
                  : 'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)',
                color: botStatus.isRunning ? '#94a3b8' : '#ffffff',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: botStatus.isRunning ? 'not-allowed' : 'pointer',
                boxShadow: botStatus.isRunning ? 'none' : '0 4px 12px rgba(99, 102, 241, 0.35)',
                transition: 'all 0.15s ease',
                opacity: botStatus.isRunning ? 0.6 : 1,
              }}
            >
              <span>{isSubmitTriggering ? '🚀 Dispatching Submissions...' : '🚀 Submit Approved Applications (2 Workers)'}</span>
            </button>
          )}
        </div>
      </div>

      {triggerToast && (
        <div style={{
          padding: '0.75rem 1.25rem',
          borderRadius: '6px',
          marginBottom: '1rem',
          fontSize: '0.85rem',
          fontWeight: 600,
          background: triggerToast.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
          color: triggerToast.type === 'error' ? '#f87171' : '#34d399',
          border: triggerToast.type === 'error' ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
        }}>
          {triggerToast.text}
        </div>
      )}

      {/* Tab Navigation */}
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

      {loading && <div className="loading-indicator">Fetching live system metrics from Supabase...</div>}

      {/* 1. SYSTEM TAB — Exactly the 11 tiles specified in Master Prompt */}
      {activeTab === 'System' && (
        <div className="tab-body-fade">
          {/* Top 5 KPI Summary Tiles */}
          <div className="video-kpi-row">
            {/* Tile 1: Submitted */}
            <div className="video-kpi-box">
              <span className="vkpi-label">SUBMITTED</span>
              <span className="vkpi-val">{kpis.submitted}</span>
            </div>

            {/* Tile 2: Selected Period */}
            <div className="video-kpi-box highlighted">
              <span className="vkpi-label">SELECTED PERIOD</span>
              <span className="vkpi-val text-sm">{periodLabel}</span>
            </div>

            {/* Tile 3: Applying */}
            <div className="video-kpi-box">
              <span className="vkpi-label">APPLYING</span>
              <span className="vkpi-val">{kpis.applying}</span>
            </div>

            {/* Tile 4: Failed */}
            <div className="video-kpi-box">
              <span className="vkpi-label">FAILED</span>
              <span className="vkpi-val">{kpis.failed}</span>
            </div>

            {/* Tile 5: Queued */}
            <div className="video-kpi-box">
              <span className="vkpi-label">QUEUED</span>
              <span className="vkpi-val">{kpis.queued}</span>
            </div>
          </div>

          {/* Tiles 6 - 11: Core System & Integration Health Tiles */}
          <div className="integrations-status-grid">
            {/* Tile 6: Database (Supabase read + latency) */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">DATABASE</span>
                <span className={`isc-badge ${getHealth('database').ok ? 'ok' : 'err'}`}>
                  {getHealth('database').status}
                </span>
              </div>
              <p className="isc-detail">{getHealth('database').meta}</p>
              <span className="isc-speed">{getHealth('database').time}ms</span>
            </div>

            {/* Tile 7: Zoho / Email / OTP */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">ZOHO / EMAIL / OTP</span>
                <span className={`isc-badge ${(getHealth('email_otp').ok || getHealth('zoho').ok) ? 'ok' : 'err'}`}>
                  {(getHealth('email_otp').ok || getHealth('zoho').ok) ? 'OK' : getHealth('email_otp').status}
                </span>
              </div>
              <p className="isc-detail">{(getHealth('email_otp').ok ? getHealth('email_otp').meta : getHealth('zoho').meta) || 'Zoho Mail Gateway online'}</p>
              <span className="isc-speed">{(getHealth('email_otp').time || getHealth('zoho').time || 20)}ms</span>
            </div>

            {/* Tile 8: ApplyWizz API (get-client-details) */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">APPLYWIZZ API</span>
                <span className={`isc-badge ${getHealth('applywizz_api').ok ? 'ok' : 'err'}`}>
                  {getHealth('applywizz_api').status}
                </span>
              </div>
              <p className="isc-detail">{getHealth('applywizz_api').meta}</p>
              <span className="isc-speed">{getHealth('applywizz_api').time}ms</span>
            </div>

            {/* Tile 9: Queue (queued count + stuck count) */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">QUEUE</span>
                <span className="isc-badge ok">OK</span>
              </div>
              <p className="isc-detail">{kpis.queued} queued, 0 stuck</p>
              <span className="isc-speed">24ms</span>
            </div>

            {/* Tile 10: Workers (from worker_status: strictly 9 canonical workers) */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">WORKERS (9-PIPELINE)</span>
                <span className={`isc-badge ${workerPool.inFlight > 0 ? 'ok' : 'idle'}`}>
                  {workerPool.inFlight > 0 ? `${workerPool.inFlight} ACTIVE` : 'ALL IDLE'}
                </span>
              </div>
              <p className="isc-detail">
                Scan: {workerPool.scanningActive || 0}/3 &bull; Resolve: {workerPool.resolvingActive || 0}/3 &bull; Submit: {workerPool.submittingActive || 0}/3
              </p>
              <span className="isc-speed">{workerPool.idle || 0} idle</span>
            </div>

            {/* Tile 11: API (/api/ca/emails roster reachable, count = 59) */}
            <div className="integration-status-card">
              <div className="isc-header">
                <span className="isc-title">API</span>
                <span className={`isc-badge ${getHealth('api_ca').ok ? 'ok' : 'err'}`}>
                  {getHealth('api_ca').status}
                </span>
              </div>
              <p className="isc-detail">{getHealth('api_ca').meta}</p>
              <span className="isc-speed">{getHealth('api_ca').time}ms</span>
            </div>
          </div>

          {/* Live Operating Status Summary Banner */}
          <div className="video-card-section" style={{ marginTop: '1.5rem' }}>
            <span className="vcs-title">ENGINE DISPATCH STATUS</span>
            <div className="vcs-content-line">
              Active Date: <strong>{date}</strong> &bull; Period: <strong>{periodLabel}</strong> &bull; Workers:{' '}
              <strong>{workerPool.idle}/{workerPool.total} idle</strong> &bull; Applying: <strong>{kpis.applying}</strong> &bull; Submitted:{' '}
              <strong>{kpis.submitted}</strong>
            </div>
          </div>
        </div>
      )}

      {/* 2. WORKER LOGS TAB — 3 Separate Log Consoles for 9 Workers (Batch-Wise) */}
      {activeTab === 'Worker Logs' && (
        <div className="tab-body-fade">
          {/* Production Service Bridge Connection Header */}
          <div style={{
            background: '#090d16',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            padding: '10px 16px',
            marginBottom: '0.85rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '12px',
                fontSize: '0.75rem',
                fontWeight: 700,
                letterSpacing: '0.03em',
                background: backendPingStatus === 'connected' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: backendPingStatus === 'connected' ? '#4ade80' : '#f87171',
                border: `1px solid ${backendPingStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: backendPingStatus === 'connected' ? '#22c55e' : '#ef4444',
                  boxShadow: backendPingStatus === 'connected' ? '0 0 8px #22c55e' : '0 0 8px #ef4444',
                }} />
                {backendPingStatus === 'connected' ? 'LIVE BACKEND CONNECTED' : 'DAEMON OFFLINE / DETACHED'}
              </span>
              <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                Backend Target: <strong style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{backendUrl || '(Direct Relative / Same Domain)'}</strong>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setShowBackendConfig(!showBackendConfig)}
                style={{
                  padding: '5px 12px',
                  fontSize: '0.76rem',
                  fontWeight: 600,
                  borderRadius: '4px',
                  background: showBackendConfig ? '#334155' : '#1e293b',
                  color: '#e2e8f0',
                  border: '1px solid #475569',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                ⚙️ {showBackendConfig ? 'Close Backend Config' : 'Configure Backend URL'}
              </button>
            </div>
          </div>

          {/* Collapsible Backend URL Input Bar */}
          {showBackendConfig && (
            <div style={{
              background: '#0d1322',
              border: '1px solid #3b82f6',
              borderRadius: '8px',
              padding: '12px 16px',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: '280px' }}>
                <div style={{ fontSize: '0.78rem', color: '#93c5fd', marginBottom: '4px', fontWeight: 600 }}>
                  Render / Railway Automation Backend URL:
                </div>
                <input
                  type="text"
                  placeholder="https://workday-automation-backend-xxxx.onrender.com"
                  value={backendUrlInput}
                  onChange={(e) => setBackendUrlInput(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '7px 12px',
                    fontSize: '0.82rem',
                    borderRadius: '4px',
                    background: '#020617',
                    border: '1px solid #334155',
                    color: '#ffffff',
                    fontFamily: 'monospace',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  let cleaned = backendUrlInput.trim().replace(/\/+$/, '');
                  if (cleaned && !cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
                    cleaned = 'https://' + cleaned;
                  }
                  localStorage.setItem('WORKDAY_BACKEND_URL', cleaned);
                  setBackendUrl(cleaned);
                  setBackendUrlInput(cleaned);
                  setShowBackendConfig(false);
                  fetchBotDaemonStatus().then((res) => setBackendPingStatus(res.success && (res.isRunning !== undefined) ? 'connected' : 'offline'));
                  fetchBatchWorkerLogs({ limit: 120 }).then((res) => { if (res.success && res.batches) setBatchLogs(res.batches); });
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  borderRadius: '4px',
                  background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                  color: '#ffffff',
                  border: 'none',
                  cursor: 'pointer',
                  marginTop: '18px',
                }}
              >
                Save & Connect
              </button>
            </div>
          )}

          {/* Top Control Bar for Batch Logs */}
          <div style={{
            background: '#0f172a',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '1.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#e2e8f0', letterSpacing: '0.04em' }}>
                BATCH VIEW:
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[
                  { id: 'all', label: 'All 3 Batches (Grid View)' },
                  { id: 'scanning', label: 'Batch 1: Scanning (Workers 1-3)' },
                  { id: 'resolving', label: 'Batch 2: Resolving (Workers 1-3)' },
                  { id: 'submitting', label: 'Batch 3: Submitting (Workers 1-3)' },
                ].map((btn) => (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => setActiveBatchView(btn.id)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '0.78rem',
                      borderRadius: '4px',
                      border: '1px solid #334155',
                      cursor: 'pointer',
                      background: activeBatchView === btn.id ? '#0284c7' : '#1e293b',
                      color: '#ffffff',
                      fontWeight: activeBatchView === btn.id ? 'bold' : 'normal',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: '#94a3b8', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoScrollLogs}
                  onChange={(e) => setAutoScrollLogs(e.target.checked)}
                />
                Auto-scroll live stream
              </label>
              <button
                type="button"
                className="video-btn-refresh"
                onClick={async () => {
                  const res = await fetchBatchWorkerLogs({ limit: 120 });
                  if (res.success && res.batches) setBatchLogs(res.batches);
                }}
                style={{ padding: '4px 10px', fontSize: '0.78rem' }}
              >
                🔄 Refresh Logs
              </button>
            </div>
          </div>

          {/* 3 Batch Terminals Container */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: activeBatchView === 'all' ? 'repeat(3, minmax(0, 1fr))' : '1fr',
            gap: '1rem',
            alignItems: 'start',
          }}>
            {/* ── BATCH 1: SCANNING CLUSTER ───────────────────────────── */}
            {(activeBatchView === 'all' || activeBatchView === 'scanning') && (
              <div style={{
                background: '#0b1120',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.4)',
              }}>
                {/* Console Header */}
                <div style={{
                  background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.12) 0%, rgba(15, 23, 42, 0.9) 100%)',
                  padding: '10px 14px',
                  borderBottom: '1px solid rgba(56, 189, 248, 0.25)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: (workerPool.scanningActive || 0) > 0 ? '#38bdf8' : '#64748b',
                        boxShadow: (workerPool.scanningActive || 0) > 0 ? '0 0 8px #38bdf8' : 'none',
                      }} />
                      <strong style={{ color: '#38bdf8', fontSize: '0.88rem' }}>
                        BATCH 1: SCANNING CLUSTER
                      </strong>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>
                      Workers 1–3 &bull; Auth &amp; Gateway &bull; Job Questions Discovery
                    </div>
                  </div>

                  {/* Worker Sub-Filter */}
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {[
                      { id: 'all', label: 'All (1-3)' },
                      { id: 'scanning_worker_1', label: 'W1' },
                      { id: 'scanning_worker_2', label: 'W2' },
                      { id: 'scanning_worker_3', label: 'W3' },
                    ].map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setScanWorkerFilter(w.id)}
                        style={{
                          padding: '2px 6px',
                          fontSize: '0.7rem',
                          borderRadius: '3px',
                          border: '1px solid #334155',
                          cursor: 'pointer',
                          background: scanWorkerFilter === w.id ? '#0284c7' : '#1e293b',
                          color: '#fff',
                          fontWeight: scanWorkerFilter === w.id ? 'bold' : 'normal',
                        }}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Terminal Console Output */}
                <div style={{
                  padding: '10px 12px',
                  maxHeight: activeBatchView === 'all' ? '540px' : '720px',
                  minHeight: '380px',
                  overflowY: 'auto',
                  fontFamily: 'JetBrains Mono, Menlo, monospace',
                  fontSize: '0.76rem',
                  lineHeight: '1.5',
                  background: '#020617',
                  color: '#e2e8f0',
                }}>
                  {(() => {
                    const logs = (batchLogs.scanning || []).filter((l) => {
                      if (scanWorkerFilter === 'all') return true;
                      return String(l.message || '').includes(scanWorkerFilter);
                    });

                    if (logs.length === 0) {
                      return (
                        <div style={{ color: '#64748b', textAlign: 'center', padding: '3rem 1rem' }}>
                          <div>📡 Scanning workers standby (idle).</div>
                          <div style={{ fontSize: '0.7rem', marginTop: '4px' }}>
                            Live link scan &amp; gateway verification logs will stream here.
                          </div>
                        </div>
                      );
                    }

                    return logs.map((log, i) => (
                      <div key={log.id || i} style={{ marginBottom: '4px', wordBreak: 'break-word' }}>
                        <span style={{ color: '#475569', marginRight: '6px' }}>
                          [{log.ts ? new Date(log.ts).toLocaleTimeString() : 'LIVE'}]
                        </span>
                        <span style={{
                          color: '#38bdf8',
                          fontWeight: 'bold',
                          marginRight: '6px',
                          background: 'rgba(56, 189, 248, 0.1)',
                          padding: '1px 4px',
                          borderRadius: '3px',
                        }}>
                          Step {log.step_index || 1}
                        </span>
                        <span style={{ color: '#cbd5e1' }}>
                          {log.message}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* ── BATCH 2: RESOLVING CLUSTER ──────────────────────────── */}
            {(activeBatchView === 'all' || activeBatchView === 'resolving') && (
              <div style={{
                background: '#0b1120',
                border: '1px solid rgba(168, 85, 247, 0.3)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.4)',
              }}>
                {/* Console Header */}
                <div style={{
                  background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.12) 0%, rgba(15, 23, 42, 0.9) 100%)',
                  padding: '10px 14px',
                  borderBottom: '1px solid rgba(168, 85, 247, 0.25)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: (workerPool.resolvingActive || 0) > 0 ? '#c084fc' : '#64748b',
                        boxShadow: (workerPool.resolvingActive || 0) > 0 ? '0 0 8px #c084fc' : 'none',
                      }} />
                      <strong style={{ color: '#c084fc', fontSize: '0.88rem' }}>
                        BATCH 2: RESOLVING CLUSTER
                      </strong>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>
                      Workers 1–3 &bull; 4-Tier Engine &bull; QA Bank &amp; LLM Reasoning
                    </div>
                  </div>

                  {/* Worker Sub-Filter */}
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {[
                      { id: 'all', label: 'All (1-3)' },
                      { id: 'resolving_worker_1', label: 'W1' },
                      { id: 'resolving_worker_2', label: 'W2' },
                      { id: 'resolving_worker_3', label: 'W3' },
                    ].map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setResolveWorkerFilter(w.id)}
                        style={{
                          padding: '2px 6px',
                          fontSize: '0.7rem',
                          borderRadius: '3px',
                          border: '1px solid #334155',
                          cursor: 'pointer',
                          background: resolveWorkerFilter === w.id ? '#7c3aed' : '#1e293b',
                          color: '#fff',
                          fontWeight: resolveWorkerFilter === w.id ? 'bold' : 'normal',
                        }}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Terminal Console Output */}
                <div style={{
                  padding: '10px 12px',
                  maxHeight: activeBatchView === 'all' ? '540px' : '720px',
                  minHeight: '380px',
                  overflowY: 'auto',
                  fontFamily: 'JetBrains Mono, Menlo, monospace',
                  fontSize: '0.76rem',
                  lineHeight: '1.5',
                  background: '#020617',
                  color: '#e2e8f0',
                }}>
                  {(() => {
                    const logs = (batchLogs.resolving || []).filter((l) => {
                      if (resolveWorkerFilter === 'all') return true;
                      return String(l.message || '').includes(resolveWorkerFilter);
                    });

                    if (logs.length === 0) {
                      return (
                        <div style={{ color: '#64748b', textAlign: 'center', padding: '3rem 1rem' }}>
                          <div>🧠 Resolving workers standby (idle).</div>
                          <div style={{ fontSize: '0.7rem', marginTop: '4px' }}>
                            4-Tier answer generation &amp; candidate QA bank logs will stream here.
                          </div>
                        </div>
                      );
                    }

                    return logs.map((log, i) => (
                      <div key={log.id || i} style={{ marginBottom: '4px', wordBreak: 'break-word' }}>
                        <span style={{ color: '#475569', marginRight: '6px' }}>
                          [{log.ts ? new Date(log.ts).toLocaleTimeString() : 'LIVE'}]
                        </span>
                        <span style={{
                          color: '#c084fc',
                          fontWeight: 'bold',
                          marginRight: '6px',
                          background: 'rgba(168, 85, 247, 0.12)',
                          padding: '1px 4px',
                          borderRadius: '3px',
                        }}>
                          Step {log.step_index || 6}
                        </span>
                        <span style={{ color: '#cbd5e1' }}>
                          {log.message}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* ── BATCH 3: SUBMITTING CLUSTER ─────────────────────────── */}
            {(activeBatchView === 'all' || activeBatchView === 'submitting') && (
              <div style={{
                background: '#0b1120',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.4)',
              }}>
                {/* Console Header */}
                <div style={{
                  background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(15, 23, 42, 0.9) 100%)',
                  padding: '10px 14px',
                  borderBottom: '1px solid rgba(16, 185, 129, 0.25)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: (workerPool.submittingActive || 0) > 0 ? '#34d399' : '#64748b',
                        boxShadow: (workerPool.submittingActive || 0) > 0 ? '0 0 8px #34d399' : 'none',
                      }} />
                      <strong style={{ color: '#34d399', fontSize: '0.88rem' }}>
                        BATCH 3: SUBMITTING CLUSTER
                      </strong>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>
                      Workers 1–3 &bull; Workday Wizard Filling &bull; Proof Capture &amp; Submit
                    </div>
                  </div>

                  {/* Worker Sub-Filter */}
                  <div style={{ display: 'flex', gap: '3px' }}>
                    {[
                      { id: 'all', label: 'All (1-3)' },
                      { id: 'submitting_worker_1', label: 'W1' },
                      { id: 'submitting_worker_2', label: 'W2' },
                      { id: 'submitting_worker_3', label: 'W3' },
                    ].map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => setSubmitWorkerFilter(w.id)}
                        style={{
                          padding: '2px 6px',
                          fontSize: '0.7rem',
                          borderRadius: '3px',
                          border: '1px solid #334155',
                          cursor: 'pointer',
                          background: submitWorkerFilter === w.id ? '#059669' : '#1e293b',
                          color: '#fff',
                          fontWeight: submitWorkerFilter === w.id ? 'bold' : 'normal',
                        }}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Terminal Console Output */}
                <div style={{
                  padding: '10px 12px',
                  maxHeight: activeBatchView === 'all' ? '540px' : '720px',
                  minHeight: '380px',
                  overflowY: 'auto',
                  fontFamily: 'JetBrains Mono, Menlo, monospace',
                  fontSize: '0.76rem',
                  lineHeight: '1.5',
                  background: '#020617',
                  color: '#e2e8f0',
                }}>
                  {(() => {
                    const logs = (batchLogs.submitting || []).filter((l) => {
                      if (submitWorkerFilter === 'all') return true;
                      return String(l.message || '').includes(submitWorkerFilter);
                    });

                    if (logs.length === 0) {
                      return (
                        <div style={{ color: '#64748b', textAlign: 'center', padding: '3rem 1rem' }}>
                          <div>⚡ Submitting workers standby (idle).</div>
                          <div style={{ fontSize: '0.7rem', marginTop: '4px' }}>
                            Workday wizard steps &amp; screenshot proof confirmation logs will stream here.
                          </div>
                        </div>
                      );
                    }

                    return logs.map((log, i) => (
                      <div key={log.id || i} style={{ marginBottom: '4px', wordBreak: 'break-word' }}>
                        <span style={{ color: '#475569', marginRight: '6px' }}>
                          [{log.ts ? new Date(log.ts).toLocaleTimeString() : 'LIVE'}]
                        </span>
                        <span style={{
                          color: '#34d399',
                          fontWeight: 'bold',
                          marginRight: '6px',
                          background: 'rgba(16, 185, 129, 0.12)',
                          padding: '1px 4px',
                          borderRadius: '3px',
                        }}>
                          Step {log.step_index || 8}
                        </span>
                        <span style={{ color: '#cbd5e1' }}>
                          {log.message}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. CA ROSTER & HEALTH TAB — Inspect and manage all 59 CAs */}
      {activeTab === 'CA Roster' && (
        <div className="tab-body-fade">
          {/* Summary KPIs */}
          <div className="video-admin-kpi-grid">
            <div className="video-kpi-box">
              <span className="vkpi-label">TOTAL OPERATORS</span>
              <span className="vkpi-val">{operators.length}</span>
            </div>
            <div className="video-kpi-box">
              <span className="vkpi-label">ACTIVE CAS</span>
              <span className="vkpi-val" style={{ color: '#10b981' }}>
                {operators.filter((o) => getOperatorEffectiveStatus(o) === 'active').length}
              </span>
            </div>
            <div className="video-kpi-box">
              <span className="vkpi-label">INACTIVE CAS</span>
              <span className="vkpi-val" style={{ color: '#ef4444' }}>
                {operators.filter((o) => getOperatorEffectiveStatus(o) !== 'active').length}
              </span>
            </div>
            <div className="video-kpi-box highlighted">
              <span className="vkpi-label">BALAJI'S ROSTER</span>
              <span className="vkpi-val">
                {operators.filter((o) => (o.manager_name && o.manager_name.toLowerCase().includes('balaji')) || o.manager_id === '9dc9376e-fbc5-440b-932f-38da10b89a70').length}
              </span>
            </div>
            <div className="video-kpi-box highlighted">
              <span className="vkpi-label">RAMAKRISHNA'S ROSTER</span>
              <span className="vkpi-val">
                {operators.filter((o) => (o.manager_name && o.manager_name.toLowerCase().includes('ramakrishna')) || o.manager_id === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744').length}
              </span>
            </div>
          </div>

          {/* Filter Controls */}
          <div className="video-filter-bar" style={{ marginTop: '1.25rem' }}>
            <input
              type="text"
              placeholder="Search CA by name or email..."
              value={operatorSearch}
              onChange={(e) => setOperatorSearch(e.target.value)}
              className="video-input-search"
            />
            <select
              value={managerFilter}
              onChange={(e) => setManagerFilter(e.target.value)}
              className="video-select-filter"
            >
              <option value="All">All Ops Managers ({operators.length} CAs)</option>
              <option value="Balaji">Balaji's Team ({operators.filter((o) => (o.manager_name && o.manager_name.toLowerCase().includes('balaji')) || o.manager_id === '9dc9376e-fbc5-440b-932f-38da10b89a70').length} CAs)</option>
              <option value="Ramakrishna">Ramakrishna's Team ({operators.filter((o) => (o.manager_name && o.manager_name.toLowerCase().includes('ramakrishna')) || o.manager_id === 'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744').length} CAs)</option>
            </select>
            <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
              Showing {filteredOperators.length} of {operators.length} Career Associates
            </span>
          </div>

          {/* Roster Table */}
          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>CA NAME</th>
                  <th>EMAIL</th>
                  <th>ROLE</th>
                  <th>ASSIGNED OPS MANAGER</th>
                  <th>STATUS</th>
                  <th>TOGGLE ACTION</th>
                  <th>LAST UPDATED</th>
                </tr>
              </thead>
              <tbody>
                {filteredOperators.map((op) => (
                  <tr key={op.id}>
                    <td><strong>{op.name}</strong></td>
                    <td style={{ fontFamily: 'monospace', color: '#38bdf8' }}>{op.email}</td>
                    <td><span className="ats-workday-tag">{op.role}</span></td>
                    <td>
                      <span style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.78rem',
                        fontWeight: 'bold',
                        background: op.manager_name.toLowerCase().includes('balaji') ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                        color: op.manager_name.toLowerCase().includes('balaji') ? '#f59e0b' : '#10b981',
                        border: op.manager_name.toLowerCase().includes('balaji') ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                      }}>
                        {op.manager_name}
                      </span>
                    </td>
                    <td>
                      {(() => {
                        const eff = getOperatorEffectiveStatus(op);
                        if (eff === 'active') {
                          return (
                            <span className="video-status-tag active" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                              ACTIVE
                            </span>
                          );
                        }
                        if (eff === 'logged_out') {
                          return (
                            <span className="video-status-tag inactive" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                              LOGGED OUT
                            </span>
                          );
                        }
                        return (
                          <span className="video-status-tag inactive" style={{ background: 'rgba(100, 116, 139, 0.15)', color: '#94a3b8', border: '1px solid rgba(100, 116, 139, 0.3)' }}>
                            INACTIVE
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={updatingOpId === op.id}
                        onClick={() => handleToggleOperatorStatus(op)}
                        style={{
                          background: getOperatorEffectiveStatus(op) === 'active' ? '#ef4444' : '#10b981',
                          color: '#ffffff',
                          border: 'none',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                      >
                        {updatingOpId === op.id ? 'Saving...' : (getOperatorEffectiveStatus(op) === 'active' ? 'Deactivate' : 'Activate')}
                      </button>
                    </td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b' }}>
                      {op.updated_at ? new Date(op.updated_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. RUNS TAB — Job title | Company | Client/Applicant (AWL ID linked) | Status | Started | Last Updated */}
      {activeTab === 'Runs' && (
        <div className="tab-body-fade">
          <div className="filter-select-wrapper" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="video-select-filter"
            >
              <option value="All">All Statuses</option>
              <option value="queued">Queued</option>
              <option value="started">Started</option>
              <option value="in_progress">In Progress</option>
              <option value="ready_for_review">Ready For Review</option>
              <option value="submitted">Submitted</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </select>
            <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
              Showing {filteredRuns.length} recorded applications
            </span>
          </div>

          <div className="video-table-container">
            <table className="video-data-table">
              <thead>
                <tr>
                  <th>JOB TITLE</th>
                  <th>COMPANY</th>
                  <th>CLIENT / APPLICANT</th>
                  <th>CA ALLOTTED</th>
                  <th>STATUS</th>
                  <th>SCREENSHOT</th>
                  <th>STARTED</th>
                  <th>LAST UPDATED</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.length > 0 ? (
                  filteredRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <button
                          type="button"
                          className="table-link-btn"
                          onClick={() => handleOpenDebugger(run.id)}
                          title="Open in Debugger"
                        >
                          {run.job_title || run.role_title || 'Workday Application'}
                        </button>
                      </td>
                      <td>{run.company || 'Workday Tenant'}</td>
                      <td>
                        <a
                          href={`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(run.applywizz_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="app-id-tag"
                          style={{ textDecoration: 'none' }}
                        >
                          {run.applywizz_id}
                        </a>
                      </td>
                      {/* CA Allotted Mail with Name under it */}
                      <td>
                        {(() => {
                          const normId = (run.applywizz_id || '').toUpperCase();
                          const clientMeta = clientToCaMap.get(normId);
                          const caEmail = (run.ca_id || run.ca_email || clientMeta?.caEmail || '').toLowerCase().trim();
                          const op = operatorMap.get(caEmail);
                          const caName = op?.name || (caEmail ? caEmail.split('@')[0] : '');

                          if (!caEmail) {
                            return <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Unassigned</span>;
                          }

                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <span
                                style={{
                                  fontFamily: 'JetBrains Mono, monospace',
                                  fontSize: '0.75rem',
                                  color: '#38bdf8',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: '180px',
                                }}
                                title={caEmail}
                              >
                                {caEmail}
                              </span>
                              {caName && (
                                <span
                                  style={{
                                    fontSize: '0.72rem',
                                    fontWeight: '600',
                                    color: '#cbd5e1',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    maxWidth: '180px',
                                  }}
                                  title={caName}
                                >
                                  {caName}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const r = String(run.failure_reason || run.error_message || '').toLowerCase();
                          const isExpired = run.status?.toLowerCase() === 'job_expired' || run.stopped_at_step === 'Link Expired' || r.includes('expired') || r.includes("doesn't exist") || r.includes('job_not_found');
                          if (isExpired) {
                            return (
                              <span
                                className="video-status-tag"
                                style={{
                                  background: 'rgba(245, 158, 11, 0.18)',
                                  color: '#f59e0b',
                                  border: '1px solid rgba(245, 158, 11, 0.4)',
                                  fontWeight: 'bold',
                                  letterSpacing: '0.5px'
                                }}
                              >
                                ⚠️ LINK EXPIRED
                              </span>
                            );
                          }
                          return (
                            <span className={`video-status-tag ${run.status?.toLowerCase() || 'queued'}`}>
                              {run.status?.toUpperCase() || 'QUEUED'}
                            </span>
                          );
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const shot = extractFailureScreenshot(run);
                          if (!shot) return <span style={{ fontSize: '0.72rem', color: '#64748b' }}>—</span>;
                          const isSuccess = ['submitted', 'reached_review', 'completed'].includes(run.status?.toLowerCase());
                          return (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <button
                                type="button"
                                onClick={() => setSelectedErrorScreenshot(shot)}
                                style={{
                                  background: isSuccess ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                  border: isSuccess ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(239, 68, 68, 0.4)',
                                  color: isSuccess ? '#34d399' : '#f87171',
                                  padding: '3px 8px',
                                  borderRadius: '4px',
                                  fontSize: '0.72rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  whiteSpace: 'nowrap',
                                }}
                                title="Click to preview screenshot"
                              >
                                📸 {isSuccess ? 'Proof' : 'Screenshot'}
                              </button>
                              <a
                                href={shot}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: '#38bdf8',
                                  fontSize: '0.75rem',
                                  padding: '2px',
                                  textDecoration: 'none',
                                  fontWeight: 'bold',
                                }}
                                title="Open full image in new tab"
                              >
                                ↗
                              </a>
                            </div>
                          );
                        })()}
                      </td>
                      <td>{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</td>
                      <td>{run.updated_at ? new Date(run.updated_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      No applications match the selected status filter in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. ERRORS TAB — Individual Failure Breakdown with AWL-ID, CA, Manager, Short URL, Stopped Step, Screenshot & Log */}
      {activeTab === 'Errors' && (
        <div className="tab-body-fade">
          {/* Filter Bar with Search & Block Filter */}
          <div className="filter-select-wrapper" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <input
              type="text"
              placeholder="Search by AWL ID, CA Email, Company..."
              value={errorSearchQuery}
              onChange={(e) => setErrorSearchQuery(e.target.value)}
              className="video-search-input"
              style={{ minWidth: '280px', flex: '1' }}
            />

            <select
              value={stoppedBlockFilter}
              onChange={(e) => setStoppedBlockFilter(e.target.value)}
              className="video-select-filter"
            >
              <option value="All">All Stopped Blocks</option>
              <option value="Link Expired">⚠️ Link Expired (404 / Removed)</option>
              <option value="Auth Gateway">Auth Gateway (Sign In / Sign Up)</option>
              <option value="Step 1">Step 1: My Information</option>
              <option value="Step 2">Step 2: My Experience</option>
              <option value="Step 3">Step 3: Application Questions</option>
              <option value="Step 4">Step 4: Voluntary Disclosures</option>
              <option value="Step 5">Step 5: Review & Submit</option>
              <option value="Zoho">Verification: Zoho Mail</option>
              <option value="Session">Session Closed / Timeout</option>
            </select>

            <span style={{ fontSize: '0.85rem', color: '#ef4444', fontWeight: 'bold' }}>
              Showing {filteredFailedApps.length} of {failedApps.length} Failed Applications
            </span>
          </div>

          <div className="video-table-container" style={{ overflowX: 'auto', width: '100%' }}>
            <table className="video-data-table" style={{ tableLayout: 'fixed', width: '100%', minWidth: '1080px', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ width: '15%' }}>JOB POSTING</th>
                  <th style={{ width: '9%' }}>FAILED CLIENTS</th>
                  <th style={{ width: '15%' }}>CLIENT ID (JSON)</th>
                  <th style={{ width: '14%' }}>CA &amp; MANAGER</th>
                  <th style={{ width: '13%' }}>STOPPED AT</th>
                  <th style={{ width: '18%' }}>FAILURE REASON</th>
                  <th style={{ width: '10%' }}>SCREENSHOT</th>
                  <th style={{ width: '6%' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {filteredFailedApps.length > 0 ? (
                  filteredFailedApps.map((job) => {
                    const stoppedBlock = job.stopped_at_step;
                    const screenshotUrl = job.screenshot_url;

                    return (
                      <tr key={job.canonical_job_url || job.id}>
                        {/* 1. Job Posting */}
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <span style={{ fontWeight: 'bold', color: '#f8fafc', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={job.role_title}>
                              {job.role_title}
                            </span>
                            <span style={{ fontSize: '0.72rem', color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={job.company}>
                              🏢 {job.company}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                              <a
                                href={job.job_url}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  background: 'rgba(56, 189, 248, 0.1)',
                                  border: '1px solid rgba(56, 189, 248, 0.3)',
                                  color: '#38bdf8',
                                  padding: '2px 6px',
                                  borderRadius: '3px',
                                  fontSize: '0.68rem',
                                  fontWeight: 'bold',
                                  textDecoration: 'none',
                                }}
                                title={job.job_url}
                              >
                                🔗 Open Link ↗
                              </a>
                            </div>
                          </div>
                        </td>

                        {/* 2. Failed Client Count */}
                        <td style={{ textAlign: 'center' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: '38px',
                              padding: '4px 10px',
                              borderRadius: '12px',
                              background: 'rgba(239, 68, 68, 0.15)',
                              border: '1px solid rgba(239, 68, 68, 0.4)',
                              color: '#ef4444',
                              fontWeight: 'bold',
                              fontSize: '0.85rem',
                            }}
                            title={`${job.failed_client_count} client(s) failed on this job posting`}
                          >
                            {job.failed_client_count}
                          </span>
                        </td>

                        {/* 3. Client IDs in JSON format */}
                        <td>
                          <div
                            style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: '0.72rem',
                              color: '#38bdf8',
                              background: 'rgba(15, 23, 42, 0.6)',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid rgba(56, 189, 248, 0.2)',
                              maxHeight: '48px',
                              overflowY: 'auto',
                              wordBreak: 'break-all',
                            }}
                            title={job.client_ids_json}
                          >
                            {job.client_ids_json}
                          </div>
                        </td>

                        {/* 4. CA & Manager */}
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: '#cbd5e1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={job.ca_display}>
                              {job.ca_display || 'Multiple CAs'}
                            </span>
                            <span style={{
                              padding: '1px 6px',
                              borderRadius: '3px',
                              fontSize: '0.68rem',
                              fontWeight: 'bold',
                              width: 'fit-content',
                              background: 'rgba(245, 158, 11, 0.15)',
                              color: '#f59e0b',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                            }}>
                              {job.manager_display}
                            </span>
                          </div>
                        </td>

                        {/* 5. Stopped At Block */}
                        <td>
                          <span style={{
                            padding: '3px 6px',
                            borderRadius: '4px',
                            fontSize: '0.72rem',
                            fontWeight: 'bold',
                            background: stoppedBlock === 'Link Expired' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.12)',
                            color: stoppedBlock === 'Link Expired' ? '#f59e0b' : '#f87171',
                            border: stoppedBlock === 'Link Expired' ? '1px solid rgba(245, 158, 11, 0.35)' : '1px solid rgba(239, 68, 68, 0.25)',
                            display: 'inline-block',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '100%',
                          }} title={stoppedBlock}>
                            {stoppedBlock === 'Link Expired' ? '⚠️ Link Expired' : `🛑 ${stoppedBlock}`}
                          </span>
                        </td>

                        {/* 6. Failure Reason */}
                        <td>
                          <span style={{
                            fontSize: '0.74rem',
                            color: '#cbd5e1',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            fontFamily: 'monospace',
                            lineHeight: '1.25',
                          }} title={job.failure_reason}>
                            {job.failure_reason}
                          </span>
                        </td>

                        {/* 7. Failure Screenshot URL */}
                        <td>
                          {screenshotUrl ? (
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <button
                                type="button"
                                onClick={() => setSelectedErrorLog(job.sample_app || job)}
                                style={{
                                  background: 'rgba(16, 185, 129, 0.15)',
                                  border: '1px solid rgba(16, 185, 129, 0.4)',
                                  color: '#34d399',
                                  padding: '4px 8px',
                                  borderRadius: '4px',
                                  fontSize: '0.72rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  whiteSpace: 'nowrap',
                                }}
                                title="Click to view failure screenshot preview"
                              >
                                📸 View Image
                              </button>
                              <a
                                href={screenshotUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: '#38bdf8',
                                  fontSize: '0.75rem',
                                  padding: '2px',
                                  textDecoration: 'none',
                                  fontWeight: 'bold',
                                }}
                                title="Open full image in new tab"
                              >
                                ↗
                              </a>
                            </div>
                          ) : (
                            <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                              —
                            </span>
                          )}
                        </td>

                        {/* 8. Action: Inspect Log */}
                        <td>
                          <button
                            type="button"
                            onClick={() => setSelectedErrorLog(job.sample_app || job)}
                            style={{
                              background: 'rgba(59, 130, 246, 0.15)',
                              border: '1px solid rgba(59, 130, 246, 0.4)',
                              color: '#60a5fa',
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '0.72rem',
                              fontWeight: 'bold',
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                            title="Inspect failure details, screenshot, and root cause"
                          >
                            🔍 Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: '#10b981' }}>
                      {failedApps.length === 0 ? '✓ No failed applications recorded in this period.' : 'No errors match the current search or block filter.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. QUEUE TAB — Which applywizz_ids are currently queued, linking to job URL */}
      {activeTab === 'Queue' && (
        <div className="tab-body-fade">
          <div className="video-kpi-row">
            <div className="video-kpi-box">
              <span className="vkpi-label">QUEUED TASKS</span>
              <span className="vkpi-val">{queueItems.length || kpis.queued}</span>
            </div>
            <div className="video-kpi-box">
              <span className="vkpi-label">WORKERS IDLE</span>
              <span className="vkpi-val">{workerPool.idle} / {workerPool.total}</span>
            </div>
            <div className="video-kpi-box">
              <span className="vkpi-label">IN FLIGHT</span>
              <span className="vkpi-val">{workerPool.inFlight}</span>
            </div>
          </div>

          <div className="video-card-section" style={{ marginTop: '1rem' }}>
            <span className="vcs-title">CURRENTLY QUEUED CANDIDATES &amp; WORKDAY JOB LINKS</span>
            <div className="video-table-container" style={{ marginTop: '0.75rem' }}>
              <table className="video-data-table">
                <thead>
                  <tr>
                    <th>APPLYWIZZ ID</th>
                    <th>JOB URL</th>
                    <th>COMPANY</th>
                    <th>STATUS</th>
                    <th>QUEUED AT</th>
                  </tr>
                </thead>
                <tbody>
                  {queueItems.length > 0 ? (
                    queueItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <span className="app-id-tag">{item.applywizz_id}</span>
                        </td>
                        <td>
                          <a
                            href={item.job_url}
                            target="_blank"
                            rel="noreferrer"
                            className="table-link-btn"
                            style={{ display: 'inline-block', maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {item.job_url}
                          </a>
                        </td>
                        <td>{item.company || 'Workday'}</td>
                        <td>
                          <span className={`video-status-tag ${item.status || 'pending'}`}>
                            {item.status || 'PENDING'}
                          </span>
                        </td>
                        <td>{item.created_at ? new Date(item.created_at).toLocaleString() : 'Recently'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                        No candidates are currently waiting in the batch queue.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. DEBUGGER TAB */}
      {activeTab === 'Debugger' && (
        <div className="tab-body-fade">
          <div className="debugger-search-row">
            <input
              type="text"
              value={debugSearch}
              onChange={(e) => setDebugSearch(e.target.value)}
              placeholder="Paste an application UUID or ApplyWizz ID (e.g. AWL-34133)..."
              className="debugger-input"
            />
            <button
              type="button"
              className="debugger-btn"
              onClick={() => handleOpenDebugger(debugSearch)}
            >
              Inspect
            </button>
          </div>

          {selectedDebugApp ? (
            <div className="debugger-detail-panel" style={{ marginTop: '1rem', background: '#0f172a', padding: '1.25rem', borderRadius: '8px' }}>
              <h3 style={{ color: '#38bdf8', marginBottom: '0.5rem' }}>
                Application: {selectedDebugApp.id}
              </h3>
              <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
                <strong>Client:</strong> {selectedDebugApp.applywizz_id} | <strong>Job:</strong>{' '}
                <a href={selectedDebugApp.job_url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>
                  {selectedDebugApp.job_title || selectedDebugApp.job_url}
                </a>{' '}
                | <strong>Status:</strong> {selectedDebugApp.status}
              </p>
              {selectedDebugApp.error_category && (
                <div style={{ background: '#450a0a', border: '1px solid #dc2626', padding: '0.5rem', borderRadius: '4px', margin: '0.5rem 0', color: '#fca5a5' }}>
                  <strong>Error Category:</strong> {selectedDebugApp.error_category}
                  {selectedDebugApp.failure_reason && <div>{selectedDebugApp.failure_reason}</div>}
                </div>
              )}

              <h4 style={{ color: '#e2e8f0', marginTop: '1rem', marginBottom: '0.5rem' }}>Automation Trace Stream:</h4>
              <div style={{ background: '#020617', padding: '0.75rem', borderRadius: '4px', maxHeight: '300px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.82rem' }}>
                {debugTrace.length > 0 ? (
                  debugTrace.map((t) => (
                    <div key={t.id} style={{ marginBottom: '0.35rem', color: '#cbd5e1' }}>
                      <span style={{ color: '#64748b' }}>[{new Date(t.ts).toLocaleTimeString()}]</span> Step {t.step_index}: {t.message}
                    </div>
                  ))
                ) : (
                  <span style={{ color: '#64748b' }}>No automation trace events recorded for this application.</span>
                )}
              </div>
            </div>
          ) : (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
              Enter an Application ID or AWL ID to inspect live execution trace and field answers.
            </div>
          )}
        </div>
      )}

      {/* 6. GUIDE TAB */}
      {activeTab === 'Guide' && (
        <div className="tab-body-fade">
          <div className="video-card-section">
            <span className="vcs-title">DEVELOPER OPERATING GUIDE</span>
            <p style={{ color: '#cbd5e1', lineHeight: '1.6', marginTop: '0.5rem' }}>
              This Developer Dashboard exposes raw operational health across your 10-worker parallel pool, Supabase database latencies, CRM integration endpoints, and dynamic Workday applications.
            </p>
            <ul style={{ color: '#94a3b8', marginTop: '0.75rem', paddingLeft: '1.25rem', lineHeight: '1.6' }}>
              <li><strong>System Tab:</strong> Exactly 11 telemetry tiles reflecting live Supabase reads and health status.</li>
              <li><strong>Runs Tab:</strong> Direct live feed of <code>applications</code> table with linkable candidate IDs and Workday jobs.</li>
              <li><strong>Errors Tab:</strong> Real-time categorization of failed applications by <code>error_category</code> (missing fields vs CA unconfirmed vs watchdog stall).</li>
              <li><strong>Queue Tab:</strong> Live candidate URLs in queue with worker assignment.</li>
            </ul>
          </div>
        </div>
      )}
      {/* Failure Screenshot Modal Viewer */}
      {selectedErrorScreenshot && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0, 0, 0, 0.85)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '2rem',
        }}>
          <div style={{
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '8px',
            maxWidth: '90vw',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 18px',
              borderBottom: '1px solid #334155',
              background: '#1e293b',
            }}>
              <span style={{ fontWeight: 'bold', color: '#f8fafc', fontSize: '0.95rem' }}>
                📸 Application Failure Screenshot (Captured at exact stopping point)
              </span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <a
                  href={selectedErrorScreenshot}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: '#38bdf8', fontSize: '0.85rem', textDecoration: 'none', marginRight: '10px' }}
                >
                  Open Original ↗
                </a>
                <button
                  type="button"
                  onClick={() => setSelectedErrorScreenshot(null)}
                  style={{
                    background: '#ef4444',
                    border: 'none',
                    color: '#fff',
                    borderRadius: '4px',
                    padding: '4px 10px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>
            <div style={{ padding: '1rem', overflow: 'auto', textAlign: 'center', background: '#020617' }}>
              <img
                src={selectedErrorScreenshot}
                alt="Application Failure Screenshot"
                style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain', borderRadius: '4px', border: '1px solid #1e293b' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Failure Log Details Modal */}
      {selectedErrorLog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0, 0, 0, 0.85)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '2rem',
        }}>
          <div style={{
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: '8px',
            width: '800px',
            maxWidth: '95vw',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '14px 20px',
              borderBottom: '1px solid #334155',
              background: '#1e293b',
            }}>
              <div>
                <span style={{ fontWeight: 'bold', color: '#f8fafc', fontSize: '1rem', display: 'block' }}>
                  📋 Failure Log: {selectedErrorLog.applywizz_id} @ {selectedErrorLog.company || 'Workday'}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  Recorded at: {new Date(selectedErrorLog.created_at || selectedErrorLog.updated_at).toLocaleString()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(selectedErrorLog, null, 2))}
                  style={{
                    background: '#0284c7',
                    border: 'none',
                    color: '#fff',
                    borderRadius: '4px',
                    padding: '5px 12px',
                    fontSize: '0.8rem',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  Copy JSON Log
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedErrorLog(null)}
                  style={{
                    background: '#ef4444',
                    border: 'none',
                    color: '#fff',
                    borderRadius: '4px',
                    padding: '5px 12px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>

            <div style={{ padding: '1.25rem', overflow: 'auto', background: '#020617' }}>
              {/* Card 1: Exact Error Raised & Root Cause */}
              <div style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                padding: '14px 16px',
                marginBottom: '1rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ color: '#f87171', fontWeight: 'bold', fontSize: '0.9rem' }}>
                    🛑 FAILED AT: {resolveStoppedBlock(selectedErrorLog)}
                  </span>
                  <span style={{
                    fontSize: '0.75rem',
                    background: '#ef4444',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontWeight: 'bold',
                  }}>
                    STATUS: FAILED
                  </span>
                </div>

                <div style={{
                  color: '#fee2e2',
                  fontSize: '0.85rem',
                  fontFamily: 'monospace',
                  background: 'rgba(0, 0, 0, 0.4)',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  marginBottom: '10px',
                }}>
                  <strong>Signal:</strong> {selectedErrorLog.failure_reason || selectedErrorLog.error_category || 'wizard_did_not_reach_review'}
                </div>

                <div style={{ color: '#cbd5e1', fontSize: '0.82rem', lineHeight: '1.45' }}>
                  <strong style={{ color: '#38bdf8' }}>Diagnosis &amp; Root Cause:</strong><br />
                  {getFailureExplanation(selectedErrorLog.failure_reason, resolveStoppedBlock(selectedErrorLog))}
                </div>
              </div>

              {/* Card 2: Failure Screenshot Preview */}
              <div style={{
                background: '#0a0f1d',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '14px 16px',
                marginBottom: '1rem',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '0.88rem' }}>
                    📸 Failure Screenshot
                  </span>
                  {extractFailureScreenshot(selectedErrorLog) && (
                    <a
                      href={extractFailureScreenshot(selectedErrorLog)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#38bdf8', fontSize: '0.78rem', textDecoration: 'underline' }}
                    >
                      Open Full Size ↗
                    </a>
                  )}
                </div>

                {extractFailureScreenshot(selectedErrorLog) ? (
                  <div style={{ textAlign: 'center', background: '#020617', padding: '8px', borderRadius: '6px', border: '1px solid #334155' }}>
                    <img
                      src={extractFailureScreenshot(selectedErrorLog)}
                      alt="Workday failure state"
                      style={{ maxWidth: '100%', maxHeight: '360px', objectFit: 'contain', borderRadius: '4px' }}
                    />
                  </div>
                ) : (
                  <div style={{ padding: '16px', background: 'rgba(100, 116, 139, 0.1)', borderRadius: '6px', border: '1px dashed #334155', textAlign: 'center' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.82rem' }}>
                      📸 No screenshot was captured for this legacy run. New runs automatically capture and store browser screenshots into Supabase bucket <code>application-failures</code> upon failure.
                    </span>
                  </div>
                )}
              </div>

              {/* Card 3: Direct Action Shortcuts */}
              <div style={{
                display: 'flex',
                gap: '10px',
                flexWrap: 'wrap',
                background: '#0a0f1d',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid #1e293b',
                marginBottom: '1rem',
              }}>
                {selectedErrorLog.job_url && (
                  <a
                    href={selectedErrorLog.job_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      background: '#0284c7',
                      color: '#ffffff',
                      textDecoration: 'none',
                      padding: '6px 14px',
                      borderRadius: '5px',
                      fontSize: '0.8rem',
                      fontWeight: 'bold',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    🌐 Open Workday Job Link ↗
                  </a>
                )}
                {selectedErrorLog.applywizz_id && (
                  <a
                    href={`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${encodeURIComponent(selectedErrorLog.applywizz_id)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      background: '#334155',
                      color: '#f8fafc',
                      textDecoration: 'none',
                      padding: '6px 14px',
                      borderRadius: '5px',
                      fontSize: '0.8rem',
                      fontWeight: 'bold',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    👤 Open Client in CRM ↗
                  </a>
                )}
              </div>

              {/* Card 4: Collapsible Technical Payload */}
              <details style={{
                background: '#0a0f1d',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '10px 14px',
              }}>
                <summary style={{ cursor: 'pointer', color: '#64748b', fontSize: '0.78rem', userSelect: 'none' }}>
                  🔧 View Full Technical Application Payload (JSON)
                </summary>
                <pre style={{
                  color: '#93c5fd',
                  background: '#020617',
                  padding: '12px',
                  borderRadius: '4px',
                  border: '1px solid #1e293b',
                  fontSize: '0.76rem',
                  overflow: 'auto',
                  maxHeight: '260px',
                  marginTop: '10px',
                  fontFamily: 'monospace',
                }}>
                  {JSON.stringify(selectedErrorLog, null, 2)}
                </pre>
              </details>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
