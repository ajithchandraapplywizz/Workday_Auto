/**
 * dashboardStats.mjs — Live Unified Stats Engine for Admin, Developer, and Manager Dashboards
 * =========================================================================================
 * PHASE F1: Live computation from submission_tasks AND job_distributions.
 *
 * Rules:
 *   1. ADDITIVE ONLY.
 *   2. Joins job_distributions and submission_tasks on distribution_id in the backend.
 *      effective_status = task ? task.status : jd.status.
 *   3. Buckets defined once in this module:
 *      - LIVE (ignores date filter): needs_answers, ready_for_review, queued, applying
 *      - PERIOD (status event time inside from..to): submitted, failed
 *      - OTHER: any other status value is counted in 'other' and never dropped; return status names
 *   4. Answer sources: raw_source supabase | resume | api | ai (or tier/source label).
 *      Unknown sources go to 'other', never 'ai'.
 *   5. Scopes:
 *      - scope = 'all' (Admin, Developer)
 *      - scope = 'manager' (Manager, strictly from verified token)
 *      - unattributed: applications not mapped to any CA or manager.
 *   6. Invariant: All buckets all-time add up to total applications.
 *   7. Cached for 15 seconds per (scope, from, to, managerId). Includes generatedAt.
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { PRESENCE_ONLINE_WINDOW_MS } from './presenceConfig.mjs';
import { extractBearerToken, verifyJwt } from './authService.mjs';
import { fetchActiveClientsFromApi } from './activeClientsSyncService.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// In-memory 15s TTL Cache
const CACHE_TTL_MS = 15_000;
const statsCache = new Map();

/**
 * Validate and parse ISO date string boundaries
 */
export function validateDateRange(from, to) {
  let fromIso = null;
  let toIso = null;

  if (from) {
    const dFrom = new Date(from);
    if (isNaN(dFrom.getTime())) {
      const err = new Error("Invalid 'from' date parameter");
      err.statusCode = 400;
      throw err;
    }
    fromIso = dFrom.toISOString();
  }

  if (to) {
    const dTo = new Date(to);
    if (isNaN(dTo.getTime())) {
      const err = new Error("Invalid 'to' date parameter");
      err.statusCode = 400;
      throw err;
    }
    toIso = dTo.toISOString();
  }

  return { fromIso, toIso };
}

/**
 * Phase F3: Canonical failure category classification function.
 * Used by Developer panel and shared Applications List.
 * Categories:
 * - Worker lease expired
 * - Daemon restart / interrupted
 * - Code error (SyntaxError, ReferenceError, TypeError text)
 * - Login / credentials
 * - Incomplete submission
 * - Other
 */
export function classifyFailure(msg) {
  const text = String(msg || '').toLowerCase();
  if (!text) return 'Other';
  if (text.includes('lease expired') || text.includes('worker lease')) {
    return 'Worker lease expired';
  }
  if (text.includes('daemon restart') || text.includes('daemon restarted') || text.includes('interrupted')) {
    return 'Daemon restart / interrupted';
  }
  if (
    text.includes('syntaxerror') ||
    text.includes('referenceerror') ||
    text.includes('typeerror') ||
    text.includes('missing catch') ||
    text.includes('finally after try') ||
    text.includes('code error')
  ) {
    return 'Code error';
  }
  if (
    text.includes('auth_failed') ||
    text.includes('login') ||
    text.includes('credentials') ||
    text.includes('password') ||
    text.includes('authentication')
  ) {
    return 'Login / credentials';
  }
  if (text.includes('incomplete')) {
    return 'Incomplete submission';
  }
  return 'Other';
}

/**
 * Core Stats Engine: getStats({ scope, from, to, managerId })
 */
export async function getStats({ scope = 'all', from = null, to = null, managerId = null } = {}) {
  const { fromIso, toIso } = validateDateRange(from, to);

  const cacheKey = `${scope}_${managerId || 'all'}_${fromIso || 'none'}_${toIso || 'none'}`;
  const now = Date.now();
  const cached = statsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // 1. Fetch job_distributions, submission_tasks, and batch_job_queue in parallel
  const [
    { data: jobDists, error: jdErr },
    { data: subTasks, error: stErr },
    { data: queueRows, error: qErr },
    { count: exactQueuedCount }
  ] = await Promise.all([
    supabase
      .from('job_distributions')
      .select('id, applywizz_id, status, updated_at, created_at, resolved_answers'),
    supabase
      .from('submission_tasks')
      .select('id, distribution_id, applywizz_id, status, error_message, created_at, started_at, completed_at, updated_at, worker_id'),
    supabase
      .from('batch_job_queue')
      .select('id, applywizz_id, status, created_at')
      .limit(10000),
    supabase
      .from('batch_job_queue')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'queued']),
  ]);

  if (jdErr) throw jdErr;
  if (stErr) throw stErr;
  if (qErr) console.warn('[STATS] batch_job_queue fetch note:', qErr.message);

  // Map submission_tasks by distribution_id
  const taskMap = new Map();
  for (const t of subTasks || []) {
    if (t.distribution_id) {
      taskMap.set(t.distribution_id, t);
    }
  }

  // 3. Mapping setup: clients -> operators -> managers
  const { data: allClients, error: clientsErr } = await supabase
    .from('clients')
    .select('applywizz_id, current_ca_email, ca_email');

  if (clientsErr) throw clientsErr;

  const clientMap = new Map();
  for (const c of allClients || []) {
    if (c.applywizz_id) clientMap.set(c.applywizz_id, c);
  }

  const { data: allOps, error: opsErr } = await supabase
    .from('operators')
    .select('id, name, email, role, manager_id, count_in_dashboard');

  if (opsErr) throw opsErr;

  const opMap = new Map();
  for (const o of allOps || []) {
    if (o.email) opMap.set(String(o.email).toLowerCase().trim(), o);
  }

  // 4. Join and determine effective application record
  // 1 application = 1 job_distributions row joined with its submission_tasks row if present
  let totalApplicationsCount = 0;
  let unattributedCount = 0;

  // Buckets
  const LIVE_STATUSES = new Set(['needs_answers', 'ready_for_review', 'queued', 'applying']);
  const PERIOD_STATUSES = new Set(['submitted', 'failed']);

  let needsAnswersCount = 0;
  let readyForReviewCount = 0;
  let queuedCount = 0;
  let applyingCount = 0;
  let submittedCount = 0;
  let failedCount = 0;
  let otherCount = 0;
  const otherStatusesMap = {};

  // Phase F3: 7-day and All-time aggregations for Submitted and Failed
  const sevenDaysAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  let submitted7dCount = 0;
  let submittedAllCount = 0;
  let failed7dCount = 0;
  let failedAllCount = 0;

  // For Developer Extras
  const failureRows = [];
  const failureRowsAll = [];
  const queuedRows = [];
  const stalledApplyingRows = [];

  // Answer sources accumulation (for applications in period)
  let ansTotal = 0;
  let ansSupabase = 0;
  let ansResume = 0;
  let ansApi = 0;
  let ansAi = 0;
  let ansOther = 0;

  for (const jd of jobDists || []) {
    const task = taskMap.get(jd.id);
    const effectiveStatus = String((task ? task.status : jd.status) || 'unknown').toLowerCase().trim();

    // Event timestamp:
    // ST has completed_at for completed rows, fallback to task.updated_at, fallback to jd.updated_at
    const eventTimeIso = task?.completed_at || task?.updated_at || jd.updated_at || jd.created_at;

    // Manager / CA mapping
    const client = clientMap.get(jd.applywizz_id);
    const caEmail = (client?.current_ca_email || client?.ca_email || '').toLowerCase().trim();
    const op = caEmail ? opMap.get(caEmail) : null;
    const assignedManagerId = op?.manager_id || null;

    // Scope check
    if (scope === 'manager') {
      if (assignedManagerId !== managerId) {
        // Skip application if not in this manager's team
        continue;
      }
    } else {
      // scope === 'all'
      if (!assignedManagerId) {
        unattributedCount++;
      }
    }

    totalApplicationsCount++;

    // In-period check for PERIOD buckets and answer sources
    const inPeriod =
      (!fromIso || eventTimeIso >= fromIso) &&
      (!toIso || eventTimeIso <= toIso);

    // LIVE BUCKETS (always computed live right now, ignore date filter)
    if (effectiveStatus === 'needs_answers') {
      needsAnswersCount++;
    } else if (effectiveStatus === 'ready_for_review') {
      readyForReviewCount++;
    } else if (effectiveStatus === 'queued') {
      queuedCount++;
      if (task) queuedRows.push(task);
    } else if (effectiveStatus === 'applying') {
      applyingCount++;
      if (task) {
        const startedTime = task.started_at ? new Date(task.started_at).getTime() : (task.updated_at ? new Date(task.updated_at).getTime() : 0);
        if (startedTime > 0 && (now - startedTime > 10 * 60 * 1000)) {
          stalledApplyingRows.push({
            task_id: task.id,
            distribution_id: task.distribution_id,
            applywizz_id: task.applywizz_id,
            worker_id: task.worker_id,
            started_at: task.started_at,
            duration_minutes: Math.round((now - startedTime) / 60000),
          });
        }
      }
    }
    // PERIOD BUCKETS (counted if status event time is inside from..to)
    else if (effectiveStatus === 'submitted') {
      submittedAllCount++;
      if (eventTimeIso >= sevenDaysAgoIso) {
        submitted7dCount++;
      }
      if (inPeriod) {
        submittedCount++;
      }
    } else if (effectiveStatus === 'failed') {
      failedAllCount++;
      if (eventTimeIso >= sevenDaysAgoIso) {
        failed7dCount++;
      }
      if (inPeriod) {
        failedCount++;
        if (task) failureRows.push(task);
        else failureRows.push({ error_message: jd.error_message || 'Application failed' });
      }
      if (task) failureRowsAll.push(task);
      else failureRowsAll.push({ error_message: jd.error_message || 'Application failed' });
    }
    // OTHER BUCKETS (any unrecognized or new status, never dropped)
    else {
      otherCount++;
      otherStatusesMap[effectiveStatus] = (otherStatusesMap[effectiveStatus] || 0) + 1;
    }

    // Answer Sources (count for applications in the period)
    if (inPeriod && jd.resolved_answers) {
      const answers = Array.isArray(jd.resolved_answers)
        ? jd.resolved_answers
        : (typeof jd.resolved_answers === 'string' ? JSON.parse(jd.resolved_answers) : null);

      if (Array.isArray(answers)) {
        for (const a of answers) {
          if (!a || a.is_answered !== true) continue;
          ansTotal++;

          const raw = String(a.raw_source || '').toLowerCase().trim();
          const tier = Number(a.tier);
          const label = String(a.source || '').toLowerCase();

          if (raw === 'supabase' || tier === 1 || label.includes('supabase') || label.includes('db')) {
            ansSupabase++;
          } else if (raw === 'resume' || tier === 2 || label.includes('resume')) {
            ansResume++;
          } else if (raw === 'api' || raw === 'crm' || tier === 3 || label.includes('crm') || label.includes('api')) {
            ansApi++;
          } else if (raw === 'ai' || raw === 'llm' || tier === 4 || label.includes('ai') || label.includes('claude') || label.includes('llm')) {
            ansAi++;
          } else {
            // Unknown sources go to 'other', NEVER 'ai'!
            ansOther++;
          }
        }
      }
    }
  }

  // 4b. Accumulate batch_job_queue items into queued, applying, ready_for_review
  for (const q of queueRows || []) {
    const st = String(q.status || 'pending').toLowerCase().trim();
    if (st === 'pending' || st === 'queued') queuedCount++;
    else if (st === 'processing' || st === 'running') applyingCount++;
    else if (st === 'ready_for_review') readyForReviewCount++;
    else if (st === 'failed') failedAllCount++;
    else if (st === 'submitted') submittedAllCount++;
    totalApplicationsCount++;
  }

  // Calculate unique active clients dynamically from authoritative active-clients API
  const activeClientsRes = await fetchActiveClientsFromApi().catch(() => ({ count: 0 }));
  const activeClientsCount = (activeClientsRes && activeClientsRes.count > 0)
    ? activeClientsRes.count
    : clientMap.size;

  // Answer sources percentages (null if none answered)
  const answerSources = {
    total: ansTotal,
    supabase_count: ansSupabase,
    resume_count: ansResume,
    api_count: ansApi,
    ai_count: ansAi,
    other_count: ansOther,
    supabase_pct: ansTotal > 0 ? Math.round((ansSupabase / ansTotal) * 100) : null,
    resume_pct: ansTotal > 0 ? Math.round((ansResume / ansTotal) * 100) : null,
    api_pct: ansTotal > 0 ? Math.round((ansApi / ansTotal) * 100) : null,
    ai_pct: ansTotal > 0 ? Math.round((ansAi / ansTotal) * 100) : null,
    other_pct: ansTotal > 0 ? Math.round((ansOther / ansTotal) * 100) : null,
  };

  const exactQueued = exactQueuedCount != null ? exactQueuedCount : queuedCount;

  const tasks = {
    needs_answers: needsAnswersCount,
    ready_for_review: readyForReviewCount,
    queued: exactQueued,
    applying: applyingCount,
    submitted: submittedCount,
    submitted_7d: submitted7dCount,
    submitted_all: submittedAllCount,
    failed: failedCount,
    failed_7d: failed7dCount,
    failed_all: failedAllCount,
    other: otherCount,
    other_statuses: otherStatusesMap,
    total_applications: (jobDists || []).length + exactQueued,
    timestamp_column: 'task.completed_at || task.updated_at || jd.updated_at',
  };

  if (scope === 'all') {
    tasks.unattributed = unattributedCount;
  }

  // Developer metrics calculation using Phase F3 canonical classifyFailure
  const failureCategories = {};
  for (const f of failureRows) {
    const cat = classifyFailure(f.error_message);
    failureCategories[cat] = (failureCategories[cat] || 0) + 1;
  }
  const failureCategoriesAll = {};
  for (const f of failureRowsAll) {
    const cat = classifyFailure(f.error_message);
    failureCategoriesAll[cat] = (failureCategoriesAll[cat] || 0) + 1;
  }

  let oldestQueuedAgeSeconds = 0;
  if (queuedRows.length > 0) {
    let oldestCreated = now;
    for (const q of queuedRows) {
      const ct = q.created_at ? new Date(q.created_at).getTime() : now;
      if (ct < oldestCreated) oldestCreated = ct;
    }
    oldestQueuedAgeSeconds = Math.max(0, Math.round((now - oldestCreated) / 1000));
  }

  const result = {
    scope,
    manager_id: managerId,
    activeClientsCount,
    tasks,
    answerSources,
    developerExtras: {
      failure_categories: failureCategories,
      failure_categories_all: failureCategoriesAll,
      stalled_applying: stalledApplyingRows,
      oldest_queued_age_seconds: oldestQueuedAgeSeconds,
    },
    generatedAt: new Date().toISOString(),
    from: fromIso,
    to: toIso,
  };

  statsCache.set(cacheKey, {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  });

  return result;
}

/**
 * Fetch and construct full payload for GET /api/admin/dashboard
 */
export async function getAdminDashboardStats({ from = null, to = null, range = 'all' } = {}) {
  const stats = await getStats({ scope: 'all', from, to });

  // Operators & CAs with count_in_dashboard = true
  const { data: allOps } = await supabase
    .from('operators')
    .select('id, name, email, role, manager_id, count_in_dashboard')
    .order('name');

  const validCas = (allOps || []).filter((o) => o.count_in_dashboard === true);
  const excludedOps = (allOps || []).filter((o) => o.count_in_dashboard === false);

  const MANAGER_NAMES = {
    '9dc9376e-fbc5-440b-932f-38da10b89a70': 'Balaji',
    'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744': 'Ramakrishna Tejavath',
  };

  const managerMap = new Map();
  for (const ca of validCas) {
    const mid = ca.manager_id || 'unassigned';
    if (!managerMap.has(mid)) {
      managerMap.set(mid, {
        manager_id: mid,
        name: MANAGER_NAMES[mid] || (mid === 'unassigned' ? 'Unassigned' : mid),
        count: 0,
      });
    }
    managerMap.get(mid).count++;
  }
  const byManager = Array.from(managerMap.values()).sort((a, b) => b.count - a.count);

  // Presence from auth_users.last_seen_at
  const { data: authUsers } = await supabase
    .from('auth_users')
    .select('id, email, last_seen_at, status');

  const authUserMap = new Map();
  for (const au of authUsers || []) {
    const em = (au.email || '').toLowerCase().trim();
    if (em) authUserMap.set(em, au);
  }

  const nowMs = Date.now();
  let activeCount = 0;
  let inactiveCount = 0;
  const operatorPresenceList = validCas.map((ca) => {
    const em = (ca.email || '').toLowerCase().trim();
    const au = authUserMap.get(em);
    const lastSeen = au?.last_seen_at || null;
    const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : 0;
    const isOnline = lastSeenTime > 0 && (nowMs - lastSeenTime <= PRESENCE_ONLINE_WINDOW_MS);

    if (isOnline) activeCount++;
    else inactiveCount++;

    return {
      id: ca.id,
      name: ca.name,
      email: ca.email,
      manager_id: ca.manager_id,
      role: ca.role,
      is_online: isOnline,
      last_seen_at: lastSeen,
    };
  });

  // Zoho Unlinked count from failure categories
  const zohoUnlinked = stats.developerExtras.failure_categories['Zoho Mailbox Unlinked / Authentication'] || 0;

  const excluded = excludedOps.map((ex) => ({
    id: ex.id,
    name: ex.name,
    email: ex.email,
    manager_id: ex.manager_id,
    reason: 'Excluded from operational dashboard roster (count_in_dashboard = false)',
  }));

  return {
    cas: {
      total: validCas.length,
      clients_total: stats.activeClientsCount,
      byManager,
    },
    primary_stats: {
      active_clients: stats.activeClientsCount,
      ready_to_review: stats.tasks.ready_for_review,
      needs_answers: stats.tasks.needs_answers,
      submitted: stats.tasks.submitted,
      failed: stats.tasks.failed,
      running: stats.tasks.applying,
      queued: stats.tasks.queued,
    },
    presence: {
      active: activeCount,
      inactive: inactiveCount,
      operators: operatorPresenceList,
    },
    tasks: stats.tasks,
    answerSources: stats.answerSources,
    integrations: {
      zoho: {
        unlinked_mailboxes: zohoUnlinked,
      },
    },
    reconciliation: {
      excluded,
    },
    generatedAt: stats.generatedAt,
    range,
    from: stats.from,
    to: stats.to,
  };
}

/**
 * Fetch and construct full payload for GET /api/developer/dashboard
 */
export async function getDeveloperDashboardStats({ from = null, to = null } = {}) {
  const stats = await getStats({ scope: 'all', from, to });

  // Fetch canonical 9 workers from worker_status table
  const { data: workers } = await supabase
    .from('worker_status')
    .select('worker_id, state, current_application_id, stage, bot_name, updated_at')
    .order('worker_id');

  const workerStatusList = (workers || []).map((w) => ({
    id: w.worker_id,
    state: w.state || 'idle',
    current_task: w.current_application_id || null,
    stage: w.stage || 'idle',
    bot_name: w.bot_name || w.worker_id,
    updated_at: w.updated_at,
  }));

  return {
    cas: {
      total: stats.activeClientsCount,
    },
    primary_stats: {
      active_clients: stats.activeClientsCount,
      ready_to_review: stats.tasks.ready_for_review,
      needs_answers: stats.tasks.needs_answers,
      submitted: stats.tasks.submitted,
      failed: stats.tasks.failed,
      running: stats.tasks.applying,
      queued: stats.tasks.queued,
    },
    tasks: stats.tasks,
    answerSources: stats.answerSources,
    worker_status: workerStatusList,
    failures: stats.developerExtras.failure_categories,
    failure_categories_all: stats.developerExtras.failure_categories_all,
    stalled_applying: stats.developerExtras.stalled_applying,
    oldest_queued_age_seconds: stats.developerExtras.oldest_queued_age_seconds,
    generatedAt: stats.generatedAt,
    from: stats.from,
    to: stats.to,
  };
}

/**
 * Fetch and construct full payload for GET /api/manager/dashboard
 */
export async function getManagerDashboardStats({ from = null, to = null, managerId } = {}) {
  if (!managerId) {
    const err = new Error('Manager identity could not be verified from token');
    err.statusCode = 403;
    throw err;
  }

  const stats = await getStats({ scope: 'manager', from, to, managerId });

  // Get manager's operators / CAs
  const { data: teamOps } = await supabase
    .from('operators')
    .select('id, name, email, role, manager_id, count_in_dashboard')
    .eq('manager_id', managerId)
    .order('name');

  const validTeamCas = (teamOps || []).filter((o) => o.count_in_dashboard === true);

  // Presence for team
  const { data: authUsers } = await supabase
    .from('auth_users')
    .select('id, email, last_seen_at');

  const authUserMap = new Map();
  for (const au of authUsers || []) {
    const em = (au.email || '').toLowerCase().trim();
    if (em) authUserMap.set(em, au);
  }

  const nowMs = Date.now();
  let activeCount = 0;
  let inactiveCount = 0;

  const teamPresenceList = validTeamCas.map((ca) => {
    const em = (ca.email || '').toLowerCase().trim();
    const au = authUserMap.get(em);
    const lastSeen = au?.last_seen_at || null;
    const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : 0;
    const isOnline = lastSeenTime > 0 && (nowMs - lastSeenTime <= PRESENCE_ONLINE_WINDOW_MS);

    if (isOnline) activeCount++;
    else inactiveCount++;

    return {
      id: ca.id,
      name: ca.name,
      email: ca.email,
      role: ca.role,
      is_online: isOnline,
      last_seen_at: lastSeen,
    };
  });

  return {
    manager_id: managerId,
    cas: {
      total: validTeamCas.length,
      operators: teamPresenceList,
    },
    presence: {
      active: activeCount,
      inactive: inactiveCount,
    },
    tasks: stats.tasks,
    answerSources: stats.answerSources,
    generatedAt: stats.generatedAt,
    from: stats.from,
    to: stats.to,
  };
}

/**
 * Resolve managerId from verified JWT payload
 */
export async function resolveManagerIdFromToken(payload) {
  if (!payload) return null;
  if (payload.manager_id) return payload.manager_id;

  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) return null;

  // 1. Look up in auth_users
  const { data: au } = await supabase
    .from('auth_users')
    .select('manager_id')
    .ilike('email', email)
    .maybeSingle();

  if (au?.manager_id) return au.manager_id;

  // 2. Look up in managers table by email or name prefix
  const { data: mgrs } = await supabase
    .from('managers')
    .select('id, email');

  for (const m of mgrs || []) {
    const mEmail = String(m.email || '').toLowerCase().trim();
    if (mEmail === email || email.split('@')[0] === mEmail.split('@')[0]) {
      return m.id;
    }
  }

  return null;
}

/**
 * Common CORS headers
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
}

/**
 * HTTP Handler: GET /api/admin/dashboard
 * Roles: admin, developer
 * Scope: all
 */
export async function handleAdminDashboardRequest(req, res, searchParams = new URLSearchParams()) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const token = extractBearerToken(req);
  let payload = null;
  if (!token) {
    const isLocal = !process.env.NODE_ENV || process.env.NODE_ENV !== 'production' ||
      req.socket?.remoteAddress === '127.0.0.1' || req.socket?.remoteAddress === '::1';
    if (isLocal) {
      payload = { email: 'developer@applywizz.ai', role: 'admin' };
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing Bearer token' }));
    }
  } else {
    payload = verifyJwt(token);
    if (!payload || !payload.email) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or expired token' }));
    }
  }

  const role = String(payload.role || '').toLowerCase().trim();
  if (!['admin', 'developer', 'dev'].includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: requires admin or developer role' }));
  }

  try {
    const range = searchParams.get('range') || 'all';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;

    const data = await getAdminDashboardStats({ from, to, range });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ...data }));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[ADMIN DASHBOARD ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

/**
 * HTTP Handler: GET /api/developer/dashboard
 * Roles: developer, admin
 * Scope: all + worker status + failures + stalled applying + oldest queued
 */
export async function handleDeveloperDashboardRequest(req, res, searchParams = new URLSearchParams()) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const token = extractBearerToken(req);
  let payload = null;
  if (!token) {
    const isLocal = !process.env.NODE_ENV || process.env.NODE_ENV !== 'production' ||
      req.socket?.remoteAddress === '127.0.0.1' || req.socket?.remoteAddress === '::1';
    if (isLocal) {
      payload = { email: 'developer@applywizz.ai', role: 'developer' };
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing Bearer token' }));
    }
  } else {
    payload = verifyJwt(token);
    if (!payload || !payload.email) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or expired token' }));
    }
  }

  const role = String(payload.role || '').toLowerCase().trim();
  if (!['developer', 'dev', 'admin'].includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: requires developer or admin role' }));
  }

  try {
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;

    const data = await getDeveloperDashboardStats({ from, to });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ...data }));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[DEVELOPER DASHBOARD ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

/**
 * HTTP Handler: GET /api/manager/dashboard
 * Roles: manager
 * Scope: that manager's team ONLY. manager_id query param is completely IGNORED.
 */
export async function handleManagerDashboardRequest(req, res, searchParams = new URLSearchParams()) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing Bearer token' }));
  }

  const payload = verifyJwt(token);
  if (!payload || !payload.email) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or expired token' }));
  }

  const role = String(payload.role || '').toLowerCase().trim();
  if (role !== 'manager') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: requires manager role' }));
  }

  // Resolve manager identity STRICTLY from token ONLY (never from query param)
  const managerId = await resolveManagerIdFromToken(payload);
  if (!managerId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: manager identity could not be verified from token' }));
  }

  try {
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;

    const data = await getManagerDashboardStats({ from, to, managerId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, ...data }));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[MANAGER DASHBOARD ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

