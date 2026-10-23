/**
 * dashboardApplications.mjs — Live Applications List Service for Admin, Developer, and Manager
 * ==========================================================================================
 * PHASE F3: Submitted and Failed applications list endpoints:
 *   - GET /api/admin/applications
 *   - GET /api/developer/applications
 *   - GET /api/manager/applications
 *
 * Rules:
 *   1. ADDITIVE ONLY.
 *   2. Same single JWT verify function and manager identity resolution.
 *   3. Manager scoping: manager sees only his team; manager_id query param is ignored.
 *   4. Columns:
 *      status, client id (applywizz_id), company, role, status time, CA (blank if unassigned),
 *      failure category, first 120 chars of error, has_screenshot, screenshot link.
 *   5. Scopes: period | 7d | all (default 7d). Newest first, 50 per page.
 */

import { createClient } from '@supabase/supabase-js';
import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { extractBearerToken, verifyJwt } from './authService.mjs';
import { classifyFailure, validateDateRange, resolveManagerIdFromToken } from './dashboardStats.mjs';

loadLocalEnvOnce();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rltnrnqqmufeeqaodsif.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    })
  : null;

/**
 * Set standard CORS headers
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/**
 * Fetch and construct unified applications list
 */
export async function getApplicationsList({
  scope = 'all',
  status = 'submitted', // 'submitted' | 'failed' | 'all'
  scopeFilter = '7d',    // 'period' | '7d' | 'all'
  from = null,
  to = null,
  limit = 50,
  cursor = null,
  managerId = null,
} = {}) {
  const normStatus = String(status || 'submitted').toLowerCase().trim();
  const normScopeFilter = String(scopeFilter || '7d').toLowerCase().trim();
  const pageSize = Math.min(Math.max(1, parseInt(limit, 10) || 100), 500);
  const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;

  // 1. Fetch job_distributions
  const { data: jobDists, error: jdErr } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, company, role_title, status, error_message, updated_at, created_at, application_submitted_screenshot_url');

  if (jdErr) throw jdErr;

  // 2. Fetch submission_tasks
  const { data: subTasks, error: stErr } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, job_url, company, role_title, status, error_message, created_at, started_at, completed_at, updated_at, screenshot_path');

  if (stErr) throw stErr;

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
    .select('id, name, email, role, manager_id');

  if (opsErr) throw opsErr;

  const opMap = new Map();
  for (const o of allOps || []) {
    if (o.email) opMap.set(String(o.email).toLowerCase().trim(), o);
  }

  // Date boundary calculations
  const now = Date.now();
  const sevenDaysAgoIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  let fromIso = null;
  let toIso = null;
  if (normScopeFilter === 'period') {
    const validated = validateDateRange(from, to);
    fromIso = validated.fromIso;
    toIso = validated.toIso;
  }

  const matchedApps = [];

  for (const jd of jobDists || []) {
    const task = taskMap.get(jd.id);
    let effectiveStatus = String((task ? task.status : jd.status) || 'unknown').toLowerCase().trim();
    if (effectiveStatus === 'ready_to_review') effectiveStatus = 'ready_for_review';

    // Status filter
    if (normStatus === 'submitted' && effectiveStatus !== 'submitted' && effectiveStatus !== 'completed') continue;
    if (normStatus === 'failed' && effectiveStatus !== 'failed') continue;
    if ((normStatus === 'ready_for_review' || normStatus === 'ready_to_review') && effectiveStatus !== 'ready_for_review') continue;
    if (normStatus === 'needs_answers' && effectiveStatus !== 'needs_answers') continue;
    if (normStatus === 'queued' && effectiveStatus !== 'queued') continue;
    if (normStatus === 'running' && effectiveStatus !== 'running' && effectiveStatus !== 'applying') continue;

    // Timestamp resolution
    const statusTimeIso = task?.completed_at || task?.updated_at || jd.updated_at || jd.created_at || new Date().toISOString();

    // CA / Manager lookup
    const client = clientMap.get(jd.applywizz_id);
    const caEmail = (client?.current_ca_email || client?.ca_email || '').toLowerCase().trim();
    const op = caEmail ? opMap.get(caEmail) : null;
    const assignedManagerId = op?.manager_id || null;

    // Manager scoping check
    if (scope === 'manager') {
      if (assignedManagerId !== managerId) {
        continue; // Strictly omit cross-team applications
      }
    }

    // Scope date filter check
    if (normScopeFilter === 'period') {
      if (fromIso && statusTimeIso < fromIso) continue;
      if (toIso && statusTimeIso > toIso) continue;
    } else if (normScopeFilter === '7d') {
      if (statusTimeIso < sevenDaysAgoIso) continue;
    }
    // 'all' has no date constraint

    // Error and screenshot metadata
    const rawError = task?.error_message || jd.error_message || '';
    const failureCategory = effectiveStatus === 'failed' ? classifyFailure(rawError) : null;
    const errorSnippet = rawError ? String(rawError).slice(0, 120) : '';

    const screenshotLink = task?.screenshot_path ||
      jd.application_submitted_screenshot_url ||
      null;
    const hasScreenshot = Boolean(screenshotLink);

    // CA field: blank string if unassigned
    const caDisplay = op?.name ? op.name : (caEmail ? caEmail : '');

    matchedApps.push({
      id: task?.id || jd.id,
      distribution_id: jd.id,
      status: effectiveStatus,
      applywizz_id: jd.applywizz_id || task?.applywizz_id || '',
      company: jd.company || task?.company || 'Unknown Company',
      role: jd.role_title || task?.role_title || 'Workday Application',
      status_time: statusTimeIso,
      ca: caDisplay,
      failure_category: failureCategory,
      error_message: errorSnippet,
      has_screenshot: hasScreenshot,
      screenshot_link: screenshotLink,
      job_url: jd.job_url || task?.job_url || null,
      client_count: 1,
    });
  }

  // If viewing failed jobs, aggregate by unique job_url and calculate client_count
  let outputApps = matchedApps;
  if (normStatus === 'failed') {
    const urlMap = new Map();
    for (const app of matchedApps) {
      const rawUrl = app.job_url || '';
      const normKey = rawUrl ? rawUrl.split('?')[0].trim().toLowerCase() : `unknown_${app.id}`;
      if (!urlMap.has(normKey)) {
        urlMap.set(normKey, {
          ...app,
          client_count: 1,
          client_ids: app.applywizz_id ? [app.applywizz_id] : [],
        });
      } else {
        const existing = urlMap.get(normKey);
        if (app.applywizz_id && !existing.client_ids.includes(app.applywizz_id)) {
          existing.client_ids.push(app.applywizz_id);
          existing.client_count = existing.client_ids.length;
        } else {
          existing.client_count = (existing.client_count || 1) + 1;
        }
        // Keep the latest timestamp and preferred screenshot
        if (new Date(app.status_time).getTime() > new Date(existing.status_time).getTime()) {
          existing.status_time = app.status_time;
          if (app.screenshot_link) {
            existing.screenshot_link = app.screenshot_link;
            existing.has_screenshot = true;
          }
          if (app.error_message) {
            existing.error_message = app.error_message;
          }
        } else if (!existing.screenshot_link && app.screenshot_link) {
          existing.screenshot_link = app.screenshot_link;
          existing.has_screenshot = true;
        }
      }
    }
    outputApps = Array.from(urlMap.values());
  }

  // Order: Newest first
  outputApps.sort((a, b) => new Date(b.status_time).getTime() - new Date(a.status_time).getTime());

  const total = outputApps.length;
  const paged = outputApps.slice(offset, offset + pageSize);
  const nextCursor = (offset + pageSize < total) ? String(offset + pageSize) : null;

  return {
    success: true,
    total,
    status: normStatus,
    scope: normScopeFilter,
    limit: pageSize,
    cursor: cursor ? String(cursor) : null,
    next_cursor: nextCursor,
    applications: paged,
  };
}

/**
 * HTTP Handler: GET /api/admin/applications
 * Role: admin
 */
export async function handleAdminApplicationsRequest(req, res, searchParams = new URLSearchParams()) {
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
  if (role !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: requires admin role' }));
  }

  try {
    const status = searchParams.get('status') || 'submitted';
    const scopeFilter = searchParams.get('scope') || '7d';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const limit = searchParams.get('limit') || 50;
    const cursor = searchParams.get('cursor') || null;

    const data = await getApplicationsList({
      scope: 'all',
      status,
      scopeFilter,
      from,
      to,
      limit,
      cursor,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[ADMIN APPLICATIONS ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

/**
 * HTTP Handler: GET /api/developer/applications
 * Role: dev, developer
 */
export async function handleDeveloperApplicationsRequest(req, res, searchParams = new URLSearchParams()) {
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
  if (!['developer', 'dev', 'admin'].includes(role)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: requires developer or admin role' }));
  }

  try {
    const status = searchParams.get('status') || 'submitted';
    const scopeFilter = searchParams.get('scope') || '7d';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const limit = searchParams.get('limit') || 50;
    const cursor = searchParams.get('cursor') || null;

    const data = await getApplicationsList({
      scope: 'all',
      status,
      scopeFilter,
      from,
      to,
      limit,
      cursor,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[DEVELOPER APPLICATIONS ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}

/**
 * HTTP Handler: GET /api/manager/applications
 * Role: manager
 * Scope: that manager's team ONLY. manager_id query param is completely IGNORED.
 */
export async function handleManagerApplicationsRequest(req, res, searchParams = new URLSearchParams()) {
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

  // Resolve manager identity STRICTLY from verified token only
  const managerId = await resolveManagerIdFromToken(payload);
  if (!managerId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Forbidden: manager identity could not be verified from token' }));
  }

  try {
    const status = searchParams.get('status') || 'submitted';
    const scopeFilter = searchParams.get('scope') || '7d';
    const from = searchParams.get('from') || null;
    const to = searchParams.get('to') || null;
    const limit = searchParams.get('limit') || 50;
    const cursor = searchParams.get('cursor') || null;

    const data = await getApplicationsList({
      scope: 'manager',
      status,
      scopeFilter,
      from,
      to,
      limit,
      cursor,
      managerId,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  } catch (err) {
    if (err.statusCode === 400) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
    console.error('[MANAGER APPLICATIONS ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
  }
}
