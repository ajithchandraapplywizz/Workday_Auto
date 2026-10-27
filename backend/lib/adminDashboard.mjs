/**
 * adminDashboard.mjs — Phase E Admin Dashboard Backend Engine
 * ============================================================
 * ONE protected backend endpoint: GET /api/admin/dashboard
 * Accepts:
 *   - range: 'today' | '7d' | '30d' | 'all' (kept for backwards compatibility)
 *   - from: ISO date string (UTC)
 *   - to: ISO date string (UTC)
 *
 * Requirements:
 *   - Auth: valid JWT required (401 if missing/invalid/expired).
 *           Role must be 'admin' or 'developer', read from the verified token only (403 otherwise).
 *   - Service role connection to Supabase (browser never directly queries tables).
 *   - Response cached at most 15 seconds.
 *   - cas: total 59, byManager (Balaji: 32, Ramakrishna: 27) WHERE count_in_dashboard = true.
 *   - presence: active, inactive, per-operator presence from auth_users.last_seen_at (within 2m).
 *   - tasks: submitted, failed, ready_for_review, queued, applying from submission_tasks
 *            using submission_tasks.updated_at for date/range filtering, plus needs_answers from job_distributions.
 *   - answerSources: percentages computed via get_answer_sources_breakdown_v2 or JS fallback.
 *   - integrations.zoho: { unlinked_mailboxes: N } using existing failure-reason/error data for period, or '—' if not computable.
 *   - reconciliation.excluded: operators WHERE count_in_dashboard = false (Zia and Shireesha).
 *   - generatedAt, range, from, to.
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { extractBearerToken, verifyJwt } from './authService.mjs';
import { PRESENCE_ONLINE_WINDOW_MS } from './presenceConfig.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// In-memory response cache (TTL 15 seconds)
const CACHE_TTL_MS = 15_000;
const responseCache = new Map();

const MANAGER_NAMES = {
  '9dc9376e-fbc5-440b-932f-38da10b89a70': 'Balaji',
  'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744': 'Ramakrishna Tejavath',
};

/**
 * Compute start boundary for a range in UTC
 */
function getRangeStartUtc(range = 'all') {
  const r = String(range || 'all').toLowerCase();
  const now = new Date();

  if (r === 'today' || r === 'day') {
    // Current day in Asia/Kolkata (IST = UTC + 5h30m)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffsetMs);
    const y = istTime.getUTCFullYear();
    const m = istTime.getUTCMonth();
    const d = istTime.getUTCDate();
    const startUtcMs = Date.UTC(y, m, d) - istOffsetMs;
    return new Date(startUtcMs).toISOString();
  } else if (r === '7d' || r === 'week') {
    return new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
  } else if (r === '30d' || r === 'month') {
    return new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
  }

  return null; // 'all'
}

/**
 * Compute 4-tier answer sources from job_distributions.resolved_answers
 * Tries RPC first; if unavailable, falls back to direct JS computation.
 */
async function computeAnswerSources(fromIso = null, toIso = null, rangeName = 'all') {
  // 1. Attempt RPC call to Postgres function
  try {
    if (fromIso || toIso) {
      const { data: rpcV2, error: errV2 } = await supabase.rpc('get_answer_sources_breakdown_v2', {
        p_from: fromIso,
        p_to: toIso,
      });
      if (!errV2 && rpcV2) return rpcV2;
    } else {
      const { data: rpcV1, error: errV1 } = await supabase.rpc('get_answer_sources_breakdown', {
        p_range: rangeName,
      });
      if (!errV1 && rpcV1) return rpcV1;
    }
  } catch (rpcErr) {
    // Proceed to robust JS fallback
  }

  // 2. Direct JS fallback over job_distributions.resolved_answers
  try {
    let query = supabase
      .from('job_distributions')
      .select('resolved_answers, updated_at')
      .not('resolved_answers', 'is', null);

    if (fromIso) {
      query = query.gte('updated_at', fromIso);
    }
    if (toIso) {
      query = query.lte('updated_at', toIso);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    let totalAnswered = 0;
    let supabaseCount = 0;
    let resumeCount = 0;
    let apiCount = 0;
    let aiCount = 0;

    for (const r of rows || []) {
      const answers = Array.isArray(r.resolved_answers)
        ? r.resolved_answers
        : (typeof r.resolved_answers === 'string' ? JSON.parse(r.resolved_answers) : null);

      if (!Array.isArray(answers)) continue;

      for (const a of answers) {
        if (!a || a.is_answered !== true) continue;

        totalAnswered++;
        const raw = String(a.raw_source || '').toLowerCase().trim();
        const tier = Number(a.tier);
        const label = String(a.source || '').toLowerCase();

        if (raw === 'supabase' || tier === 1 || label.includes('supabase') || label.includes('db')) {
          supabaseCount++;
        } else if (raw === 'resume' || tier === 2 || label.includes('resume')) {
          resumeCount++;
        } else if (raw === 'api' || raw === 'crm' || tier === 3 || label.includes('crm') || label.includes('api')) {
          apiCount++;
        } else if (raw === 'ai' || tier === 4 || label.includes('ai') || label.includes('claude')) {
          aiCount++;
        } else {
          aiCount++;
        }
      }
    }

    if (totalAnswered === 0) {
      return {
        total: 0,
        supabase_count: 0,
        resume_count: 0,
        api_count: 0,
        ai_count: 0,
        supabase_pct: null,
        resume_pct: null,
        api_pct: null,
        ai_pct: null,
      };
    }

    const sbPct = Math.round((supabaseCount / totalAnswered) * 100);
    const resPct = Math.round((resumeCount / totalAnswered) * 100);
    const apiPct = Math.round((apiCount / totalAnswered) * 100);
    const aiPct = Math.max(0, 100 - (sbPct + resPct + apiPct));

    return {
      total: totalAnswered,
      supabase_count: supabaseCount,
      resume_count: resumeCount,
      api_count: apiCount,
      ai_count: aiCount,
      supabase_pct: sbPct,
      resume_pct: resPct,
      api_pct: apiPct,
      ai_pct: aiPct,
    };
  } catch (err) {
    console.warn('[ADMIN DASHBOARD] Answer sources computation note:', err?.message);
    return {
      total: 0,
      supabase_count: 0,
      resume_count: 0,
      api_count: 0,
      ai_count: 0,
      supabase_pct: null,
      resume_pct: null,
      api_pct: null,
      ai_pct: null,
    };
  }
}

/**
 * Main Data Gathering Function for Phase E
 * Accepts options object: { range, from, to } or positional (range, from, to)
 */
export async function getAdminDashboardData(opts = 'all', optFrom = null, optTo = null) {
  let range = 'all';
  let from = null;
  let to = null;

  if (typeof opts === 'object' && opts !== null) {
    range = opts.range || 'all';
    from = opts.from || null;
    to = opts.to || null;
  } else {
    range = opts || 'all';
    from = optFrom;
    to = optTo;
  }

  // Validate dates if supplied
  let boundsStartIso = null;
  let boundsEndIso = null;

  if (from) {
    const dFrom = new Date(from);
    if (isNaN(dFrom.getTime())) {
      const err = new Error("Invalid 'from' date parameter");
      err.statusCode = 400;
      throw err;
    }
    boundsStartIso = dFrom.toISOString();
  }

  if (to) {
    const dTo = new Date(to);
    if (isNaN(dTo.getTime())) {
      const err = new Error("Invalid 'to' date parameter");
      err.statusCode = 400;
      throw err;
    }
    boundsEndIso = dTo.toISOString();
  }

  // If from/to not supplied, calculate from range
  if (!boundsStartIso && !boundsEndIso) {
    boundsStartIso = getRangeStartUtc(range);
  }

  // [PHASE F1 GUARD]: Delegate to unified live stats engine from dashboardStats.mjs
  const { getAdminDashboardStats } = await import('./dashboardStats.mjs');
  return getAdminDashboardStats({ from: boundsStartIso, to: boundsEndIso, range });

  /* [OLD PATH PRESERVED FOR ADDITIVE SAFETY] */
  const cacheKey = `${String(range || 'all')}_${boundsStartIso || 'none'}_${boundsEndIso || 'none'}`;
  const now = Date.now();
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // 1. Operators & CAs with count_in_dashboard = true
  const { data: allOps, error: opsErr } = await supabase
    .from('operators')
    .select('id, name, email, role, manager_id, count_in_dashboard')
    .order('name');

  if (opsErr) throw opsErr;

  const validCas = (allOps || []).filter((o) => o.count_in_dashboard === true);
  const excludedOps = (allOps || []).filter((o) => o.count_in_dashboard === false);

  // By Manager
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

  // 2. Presence from auth_users.last_seen_at
  const { data: authUsers, error: authErr } = await supabase
    .from('auth_users')
    .select('id, email, last_seen_at, status');

  if (authErr) throw authErr;

  const authUserMap = new Map();
  for (const au of authUsers || []) {
    const em = (au.email || '').toLowerCase().trim();
    if (em) authUserMap.set(em, au);
  }

  let activeCount = 0;
  let inactiveCount = 0;
  const operatorPresenceList = validCas.map((ca) => {
    const em = (ca.email || '').toLowerCase().trim();
    const au = authUserMap.get(em);
    const lastSeen = au?.last_seen_at || null;
    const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : 0;
    const isOnline = lastSeenTime > 0 && (now - lastSeenTime <= PRESENCE_ONLINE_WINDOW_MS);

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

  // 3. Execution Tasks from submission_tasks (Source of Truth)
  // Date filter applies to submission_tasks.updated_at
  let subQuery = supabase
    .from('submission_tasks')
    .select('id, status, error_message, updated_at, created_at, completed_at');

  if (boundsStartIso) {
    subQuery = subQuery.gte('updated_at', boundsStartIso);
  }
  if (boundsEndIso) {
    subQuery = subQuery.lte('updated_at', boundsEndIso);
  }

  const { data: subTasks, error: subErr } = await subQuery;
  if (subErr) throw subErr;

  const taskCounts = {
    submitted: 0,
    failed: 0,
    ready_for_review: 0,
    queued: 0,
    applying: 0,
  };

  let zohoUnlinkedCount = 0;

  for (const t of subTasks || []) {
    const s = String(t.status || '').toLowerCase().trim();
    if (s === 'submitted') taskCounts.submitted++;
    else if (s === 'failed') taskCounts.failed++;
    else if (s === 'ready_for_review') taskCounts.ready_for_review++;
    else if (s === 'queued') taskCounts.queued++;
    else if (s === 'applying') taskCounts.applying++;

    const errMsg = String(t.error_message || '').toLowerCase();
    if (errMsg.includes('zoho') || errMsg.includes('mailbox')) {
      zohoUnlinkedCount++;
    }
  }

  // Also read needs_answers from job_distributions
  let distQuery = supabase
    .from('job_distributions')
    .select('id, status, updated_at')
    .eq('status', 'needs_answers');

  if (boundsStartIso) {
    distQuery = distQuery.gte('updated_at', boundsStartIso);
  }
  if (boundsEndIso) {
    distQuery = distQuery.lte('updated_at', boundsEndIso);
  }

  const { data: needsAnswersRows, error: distErr } = await distQuery;
  if (distErr) throw distErr;
  const needsAnswersCount = (needsAnswersRows || []).length;

  // 4. Answer Sources Breakdown
  const answerSources = await computeAnswerSources(boundsStartIso, boundsEndIso, range);

  // 5. Integrations: Zoho Mailbox status from failure data for period
  const integrations = {
    zoho: {
      unlinked_mailboxes: zohoUnlinkedCount,
    },
  };

  // 6. Reconciliation: excluded operators
  const excluded = excludedOps.map((ex) => ({
    id: ex.id,
    name: ex.name,
    email: ex.email,
    manager_id: ex.manager_id,
    reason: 'Excluded from operational dashboard roster (count_in_dashboard = false)',
  }));

  const payload = {
    cas: {
      total: validCas.length,
      byManager,
    },
    presence: {
      active: activeCount,
      inactive: inactiveCount,
      operators: operatorPresenceList,
    },
    tasks: {
      submitted: taskCounts.submitted,
      failed: taskCounts.failed,
      ready_for_review: taskCounts.ready_for_review,
      queued: taskCounts.queued,
      applying: taskCounts.applying,
      needs_answers: needsAnswersCount,
      timestamp_column: 'submission_tasks.updated_at',
    },
    answerSources,
    integrations,
    reconciliation: {
      excluded,
    },
    generatedAt: new Date().toISOString(),
    range,
    from: boundsStartIso,
    to: boundsEndIso,
  };

  // Save to cache (TTL 15 seconds)
  responseCache.set(cacheKey, {
    data: payload,
    expiresAt: now + CACHE_TTL_MS,
  });

  return payload;
}

/**
 * HTTP Request Handler for GET /api/admin/dashboard
 */
export async function handleAdminDashboardRequest(req, res, searchParams = new URLSearchParams()) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Verify JWT from Authorization header
  const token = extractBearerToken(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing Bearer token' }));
    return;
  }

  const payload = verifyJwt(token);
  if (!payload || !payload.email) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or expired token' }));
    return;
  }

  // 2. Role Check: Strictly 'admin' or 'developer' / 'dev' from verified token ONLY
  const role = String(payload.role || '').toLowerCase().trim();
  const allowed = ['admin', 'developer', 'dev'];
  if (!allowed.includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: requires admin or developer role' }));
    return;
  }

  // 3. Process Request with date validation
  try {
    const range = searchParams.get('range') || 'all';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;

    const data = await getAdminDashboardData({ range, from, to });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...data }));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
    console.error('[ADMIN DASHBOARD ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}
