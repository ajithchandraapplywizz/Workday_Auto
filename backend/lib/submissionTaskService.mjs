/**
 * Service for CA Submission Tasks
 * Single identity end-to-end: submission_tasks.id
 * No write path ever filters by applywizz_id.
 */

import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Check whether a CA is assigned to a specific client.
 * Returns true if assigned or if caIdentifier is recognized as active operator/admin.
 */
export async function isCaAssignedToClient(caIdentifier, applywizzId) {
  if (!caIdentifier || !applywizzId) return false;
  const cleanId = String(applywizzId).trim().toUpperCase();
  const cleanCa = String(caIdentifier).trim().toLowerCase();

  try {
    // 1. Check clients table for current_ca_email
    const { data: clientRow } = await supabase
      .from('clients')
      .select('applywizz_id, current_ca_email')
      .eq('applywizz_id', cleanId)
      .maybeSingle();

    if (clientRow?.current_ca_email && clientRow.current_ca_email.toLowerCase().trim() === cleanCa) {
      return true;
    }

    // 2. Check client_assignment_log table
    const { data: assignmentLogs } = await supabase
      .from('client_assignment_log')
      .select('id')
      .eq('applywizz_id', cleanId)
      .ilike('ca_email', cleanCa)
      .limit(1);

    if (assignmentLogs && assignmentLogs.length > 0) {
      return true;
    }

    // 3. Check if operator is active admin / manager with oversight permissions
    const { data: op } = await supabase
      .from('operators')
      .select('role, status')
      .ilike('email', cleanCa)
      .maybeSingle();

    if (op && (op.role === 'admin' || op.role === 'manager' || op.role === 'Developer')) {
      return true;
    }

    return false;
  } catch (err) {
    console.warn(`[isCaAssignedToClient] Error checking assignment for ${cleanId}:`, err.message);
    return false;
  }
}

/**
 * Click Submission Handler:
 * - Takes taskId only
 * - Validates CA assignment to task client
 * - Single atomic statement:
 *     UPDATE submission_tasks SET status='queued', reviewed_by=:ca, updated_at=now()
 *     WHERE id=:taskId AND status='ready_for_review' RETURNING *
 * - Zero rows returned means already queued or taken -> returns current status without error
 * - Never filters write path by applywizz_id
 */
export async function queueSubmissionTask({ taskId, ca = 'Career Associate' }) {
  if (!taskId) {
    return { success: false, statusCode: 400, error: 'Task ID is required' };
  }

  const cleanTaskId = String(taskId).trim();

  // 1. Fetch task row by taskId ONLY (read path)
  const { data: task, error: tErr } = await supabase
    .from('submission_tasks')
    .select('id, distribution_id, applywizz_id, status, job_url, company, role_title')
    .eq('id', cleanTaskId)
    .maybeSingle();

  if (tErr) {
    return { success: false, statusCode: 500, error: 'Database error fetching task: ' + tErr.message };
  }
  if (!task) {
    return { success: false, statusCode: 404, error: `Task not found with id: ${cleanTaskId}` };
  }

  // 2. Validate that CA is assigned to this task's client
  const caNameOrEmail = String(ca).trim();
  const isAssigned = await isCaAssignedToClient(caNameOrEmail, task.applywizz_id);
  if (!isAssigned) {
    // Also allow if generic 'Career Associate' or dev testing
    const isDevOrGeneric = caNameOrEmail === 'Career Associate' || caNameOrEmail === 'Developer';
    if (!isDevOrGeneric) {
      return {
        success: false,
        statusCode: 403,
        error: `CA '${caNameOrEmail}' is not assigned to client ${task.applywizz_id}`,
      };
    }
  }

  // 3. Single atomic statement:
  // UPDATE submission_tasks SET status='queued', reviewed_by=:ca, updated_at=now()
  // WHERE id=:taskId AND status='ready_for_review' RETURNING *
  const now = new Date().toISOString();
  const { data: updatedRows, error: updateErr } = await supabase
    .from('submission_tasks')
    .update({
      status: 'queued',
      status_actor: 'system',
      reviewed_by: caNameOrEmail,
      updated_at: now,
    })
    .eq('id', cleanTaskId)
    .eq('status', 'ready_for_review')
    .select('*');

  if (updateErr) {
    return { success: false, statusCode: 500, error: 'Failed to queue task: ' + updateErr.message };
  }

  // 4. Zero rows returned means already queued, applying, or submitted:
  // Return the current status and DO NOT error (safe against double-clicks & refreshes)
  if (!updatedRows || updatedRows.length === 0) {
    const { data: currentTask } = await supabase
      .from('submission_tasks')
      .select('id, distribution_id, applywizz_id, status, worker_id, updated_at')
      .eq('id', cleanTaskId)
      .maybeSingle();

    return {
      success: true,
      statusCode: 200,
      changed: false,
      message: 'Task is already queued or in progress',
      status: currentTask?.status || 'unknown',
      task: currentTask,
    };
  }

  // Exactly one row was atomically updated to 'queued'
  return {
    success: true,
    statusCode: 200,
    changed: true,
    message: 'Task successfully queued for worker pickup',
    status: 'queued',
    task: updatedRows[0],
  };
}
