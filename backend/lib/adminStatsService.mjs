/**
 * adminStatsService.mjs — Backend Admin Statistics Engine
 * =======================================================
 * Computes windowed submission stats, live counts, 4-tier resolved answer percentages,
 * and CA operator roster presence tracking.
 *
 * Requirements:
 *   - Range: day | week | month (boundaries in Asia/Kolkata IST)
 *   - Date: YYYY-MM-DD
 *   - submitted, failed: completed_at within IST window
 *   - running (applying), queued, ready_for_review: live counts (not filtered by date)
 *   - sources: tiers 1-4 as denominator, average and pooled percentages, tier 0 as unanswered_count
 *   - operators: live CA roster matching (59), dynamic 2-min presence, not_in_roster list
 *   - generated_at: ISO timestamp
 *   - Empty windows: 0 counts, null percentages (never NaN or error)
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

// Cache for live CA roster (TTL 60s)
let cachedRoster = null;
let lastRosterFetch = 0;

/**
 * Get current date string in IST (Asia/Kolkata)
 */
export function getTodayIST() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffsetMs);
  return istTime.toISOString().slice(0, 10);
}

/**
 * Compute UTC start and end bounds for an IST date & range
 */
export function computeIstWindow(range = 'day', dateStr = null) {
  const dStr = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getTodayIST();
  const [year, month, day] = dStr.split('-').map(Number);

  // Reference date at 00:00:00 in IST = (UTC time minus 5h 30m)
  // E.g., 2026-10-11 00:00:00 IST is 2026-10-10 18:30:00.000 UTC
  const istOffsetMs = 5.5 * 60 * 60 * 1000;

  let startUtcMs = 0;
  let endUtcMs = 0;

  const r = String(range || 'day').toLowerCase();

  if (r === 'week') {
    // Determine Monday 00:00:00 IST of this week
    const targetUtc = Date.UTC(year, month - 1, day);
    // Day of week in UTC (0 is Sunday, 1 is Monday... 6 is Saturday)
    const dayOfWeek = new Date(targetUtc).getUTCDay();
    const diffToMonday = (dayOfWeek + 6) % 7; // days since Monday
    const mondayUtc = targetUtc - diffToMonday * 86400 * 1000;

    startUtcMs = mondayUtc - istOffsetMs;
    endUtcMs = startUtcMs + 7 * 86400 * 1000 - 1;
  } else if (r === 'month') {
    // 1st of month 00:00:00 IST to last day 23:59:59.999 IST
    const startOfMonthUtc = Date.UTC(year, month - 1, 1);
    startUtcMs = startOfMonthUtc - istOffsetMs;

    const nextMonthUtc = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
    endUtcMs = nextMonthUtc - istOffsetMs - 1;
  } else {
    // 'day'
    const dayStartUtc = Date.UTC(year, month - 1, day);
    startUtcMs = dayStartUtc - istOffsetMs;
    endUtcMs = startUtcMs + 86400 * 1000 - 1;
  }

  return {
    range: r,
    date: dStr,
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
  };
}

/**
 * Fetch live CA roster emails from API with cached fallback
 */
export async function getLiveCaRoster() {
  const now = Date.now();
  if (cachedRoster && now - lastRosterFetch < 60_000) {
    return cachedRoster;
  }

  try {
    const res = await fetch('https://applywizz-ca-management.vercel.app/api/ca/emails', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = data.users || [];
      const emailSet = new Set(list.map((u) => String(u.email || '').toLowerCase().trim()).filter(Boolean));
      if (emailSet.size > 0) {
        cachedRoster = emailSet;
        lastRosterFetch = now;
        return emailSet;
      }
    }
  } catch (err) {
    console.warn('[ADMIN STATS] Could not reach external CA roster API:', err?.message);
  }

  if (cachedRoster) return cachedRoster;

  // Fallback: load known roster from operators table if network unavailable
  try {
    const { data: ops } = await supabase.from('operators').select('email');
    const set = new Set();
    const exclude = new Set(['ziamd@applywizz.com', 'shireeshaj@applywizz.com']);
    (ops || []).forEach((o) => {
      const em = (o.email || '').toLowerCase().trim();
      if (em && !exclude.has(em)) set.add(em);
    });
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Fetch and compute operators stats (total, online_now, offline, not_in_roster)
 */
export async function getOperatorStats() {
  const [rosterSet, opsRes, authRes] = await Promise.all([
    getLiveCaRoster(),
    supabase.from('operators').select('name, email, role, status').order('name', { ascending: true }),
    supabase.from('auth_users').select('email, last_seen_at, status'),
  ]);

  const authMap = new Map();
  (authRes.data || []).forEach((u) => {
    const em = (u.email || '').toLowerCase().trim();
    if (em) authMap.set(em, u);
  });

  const notInRoster = [];
  let inRosterCount = 0;
  let onlineNow = 0;
  const now = Date.now();

  for (const op of (opsRes.data || [])) {
    const em = (op.email || '').toLowerCase().trim();
    if (!rosterSet.has(em)) {
      notInRoster.push({
        name: op.name,
        email: op.email,
        status: op.status,
      });
    } else {
      inRosterCount++;
      const authUser = authMap.get(em);
      if (authUser?.last_seen_at) {
        const lastSeenMs = new Date(authUser.last_seen_at).getTime();
        // Dynamic presence rule: active if last_seen_at within 2 minutes (120,000 ms)
        if (!isNaN(lastSeenMs) && now - lastSeenMs <= 120_000) {
          onlineNow++;
        }
      }
    }
  }

  return {
    total: inRosterCount,
    online_now: onlineNow,
    offline: Math.max(0, inRosterCount - onlineNow),
    not_in_roster: notInRoster,
  };
}

/**
 * Compute submission & sources stats directly via SQL/Supabase
 */
export async function getSubmissionAndSourceStats(range = 'day', date = null) {
  const window = computeIstWindow(range, date);

  // 1. Attempt Supabase RPC first if available
  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_admin_stats', {
      p_range: window.range,
      p_date: window.date,
    });

    if (!rpcError && rpcData && typeof rpcData === 'object' && rpcData.submitted !== undefined) {
      return {
        submitted: rpcData.submitted ?? 0,
        failed: rpcData.failed ?? 0,
        running: rpcData.running ?? 0,
        queued: rpcData.queued ?? 0,
        ready_for_review: rpcData.ready_for_review ?? 0,
        sources: rpcData.sources ?? {
          supabase_pct: null,
          resume_pct: null,
          crm_pct: null,
          ai_pct: null,
          pooled: { supabase_pct: null, resume_pct: null, crm_pct: null, ai_pct: null },
          pooled_supabase_pct: null,
          pooled_resume_pct: null,
          pooled_crm_pct: null,
          pooled_ai_pct: null,
          unanswered_count: 0,
          applications_included: 0,
        },
      };
    }
  } catch (err) {
    // Fall through to query execution
  }

  // 2. Direct SQL Query execution
  const [liveRunningRes, liveQueuedRes, liveReadyRes, windowTasksRes] = await Promise.all([
    supabase.from('submission_tasks').select('*', { count: 'exact', head: true }).eq('status', 'applying'),
    supabase.from('submission_tasks').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
    supabase.from('submission_tasks').select('*', { count: 'exact', head: true }).eq('status', 'ready_for_review'),
    supabase.from('submission_tasks')
      .select('id, status, completed_at, distribution_id')
      .in('status', ['submitted', 'failed'])
      .gte('completed_at', window.startIso)
      .lte('completed_at', window.endIso),
  ]);

  const running = liveRunningRes.count ?? 0;
  const queued = liveQueuedRes.count ?? 0;
  const ready_for_review = liveReadyRes.count ?? 0;

  const windowTasks = windowTasksRes.data || [];
  let submitted = 0;
  let failed = 0;

  const distributionIds = [];
  for (const t of windowTasks) {
    if (t.status === 'submitted') submitted++;
    if (t.status === 'failed') failed++;
    if (t.distribution_id) distributionIds.push(t.distribution_id);
  }

  let pooled0 = 0;
  let pooled1 = 0;
  let pooled2 = 0;
  let pooled3 = 0;
  let pooled4 = 0;

  let sumAvg1 = 0;
  let sumAvg2 = 0;
  let sumAvg3 = 0;
  let sumAvg4 = 0;
  let appsIncluded = 0;

  if (distributionIds.length > 0) {
    const { data: distRows } = await supabase
      .from('job_distributions')
      .select('id, resolved_answers')
      .in('id', distributionIds);

    const distMap = new Map();
    (distRows || []).forEach((d) => distMap.set(d.id, d.resolved_answers));

    for (const t of windowTasks) {
      const answers = distMap.get(t.distribution_id) || [];
      if (!Array.isArray(answers) || answers.length === 0) continue;

      let t0 = 0;
      let t1 = 0;
      let t2 = 0;
      let t3 = 0;
      let t4 = 0;

      for (const a of answers) {
        let tier = a.tier !== undefined ? Number(a.tier) : (a.is_answered === false ? 0 : 1);
        if (isNaN(tier)) tier = 1;

        if (tier === 0) t0++;
        else if (tier === 1) t1++;
        else if (tier === 2) t2++;
        else if (tier === 3) t3++;
        else if (tier === 4) t4++;
      }

      const answered = t1 + t2 + t3 + t4;
      pooled0 += t0;
      pooled1 += t1;
      pooled2 += t2;
      pooled3 += t3;
      pooled4 += t4;

      if (answered > 0) {
        sumAvg1 += (t1 / answered) * 100;
        sumAvg2 += (t2 / answered) * 100;
        sumAvg3 += (t3 / answered) * 100;
        sumAvg4 += (t4 / answered) * 100;
        appsIncluded++;
      }
    }
  }

  const totalAnswered = pooled1 + pooled2 + pooled3 + pooled4;

  const round2 = (num) => (num !== null && !isNaN(num) ? Math.round(num * 100) / 100 : null);

  const sources = {
    supabase_pct: appsIncluded > 0 ? round2(sumAvg1 / appsIncluded) : null,
    resume_pct: appsIncluded > 0 ? round2(sumAvg2 / appsIncluded) : null,
    crm_pct: appsIncluded > 0 ? round2(sumAvg3 / appsIncluded) : null,
    ai_pct: appsIncluded > 0 ? round2(sumAvg4 / appsIncluded) : null,
    pooled: {
      supabase_pct: totalAnswered > 0 ? round2((pooled1 / totalAnswered) * 100) : null,
      resume_pct: totalAnswered > 0 ? round2((pooled2 / totalAnswered) * 100) : null,
      crm_pct: totalAnswered > 0 ? round2((pooled3 / totalAnswered) * 100) : null,
      ai_pct: totalAnswered > 0 ? round2((pooled4 / totalAnswered) * 100) : null,
    },
    pooled_supabase_pct: totalAnswered > 0 ? round2((pooled1 / totalAnswered) * 100) : null,
    pooled_resume_pct: totalAnswered > 0 ? round2((pooled2 / totalAnswered) * 100) : null,
    pooled_crm_pct: totalAnswered > 0 ? round2((pooled3 / totalAnswered) * 100) : null,
    pooled_ai_pct: totalAnswered > 0 ? round2((pooled4 / totalAnswered) * 100) : null,
    unanswered_count: pooled0,
    applications_included: appsIncluded,
  };

  return {
    submitted,
    failed,
    running,
    queued,
    ready_for_review,
    sources,
  };
}

/**
 * Main Controller: Handle GET /api/admin/stats
 */
export async function handleAdminStatsRequest(req, res, queryParams) {
  try {
    const range = queryParams.get('range') || 'day';
    const date = queryParams.get('date') || getTodayIST();

    const [subStats, opStats] = await Promise.all([
      getSubmissionAndSourceStats(range, date),
      getOperatorStats(),
    ]);

    const responsePayload = {
      submitted: subStats.submitted,
      failed: subStats.failed,
      running: subStats.running,
      queued: subStats.queued,
      ready_for_review: subStats.ready_for_review,
      sources: subStats.sources,
      operators: opStats,
      generated_at: new Date().toISOString(),
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
    });
    return res.end(JSON.stringify(responsePayload));
  } catch (err) {
    console.error('[ADMIN STATS API] Unexpected error:', err);
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({
      error: 'Failed to generate admin statistics',
      details: err?.message,
      generated_at: new Date().toISOString(),
    }));
  }
}
