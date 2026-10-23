/**
 * Deterministic Screenshot Identity Service (Phase 4)
 * - Deterministic Storage Path: submitted-applications/{applywizz_id}/{task_id}.png
 * - Order:
 *     1. Upload screenshot buffer to Supabase Storage
 *     2. Verify stored path contains the claimed task_id
 *     3. Single atomic statement on submission_tasks:
 *        WHERE id = :taskId AND status = 'applying' AND worker_id = :workerId
 *     4. Retry on DB update failure (orphan file in bucket is harmless)
 *     5. Database trigger mirrors to job_distributions
 */

import { loadLocalEnvOnce } from './supabaseClient.mjs';
import { createClient } from '@supabase/supabase-js';

loadLocalEnvOnce();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const BUCKET_NAME = 'submitted-applications';

/**
 * Upload screenshot and record submission proof on task row.
 * Never picks "latest file". Uses deterministic task_id only.
 */
export async function recordTaskSubmissionProof({
  taskId,
  applywizzId,
  workerId,
  imageBuffer,
  maxRetries = 3,
}) {
  if (!taskId || !applywizzId || !workerId || !imageBuffer) {
    throw new Error('Missing required arguments: taskId, applywizzId, workerId, imageBuffer');
  }

  const cleanTaskId = String(taskId).trim();
  const cleanId = String(applywizzId).trim().toUpperCase();
  const storagePath = `${cleanId}_${cleanTaskId}.png`;

  // 1. Verify path contains the exact task ID before upload
  if (!storagePath.includes(cleanTaskId)) {
    throw new Error(`Deterministic validation failed: Path '${storagePath}' does not contain task id '${cleanTaskId}'`);
  }

  // 2. Upload to Supabase Storage
  const { data: uploadData, error: uploadErr } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (uploadErr) {
    throw new Error(`Failed to upload screenshot to ${BUCKET_NAME}/${storagePath}: ${uploadErr.message}`);
  }

  // 3. Verify the stored path contains claimed task id
  if (!uploadData?.path || !uploadData.path.includes(cleanTaskId)) {
    throw new Error(`Upload verification failed: stored path '${uploadData?.path}' does not contain task id '${cleanTaskId}'`);
  }

  // 4. Resolve public URL
  const { data: urlData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(storagePath);

  const publicUrl = urlData.publicUrl;
  if (!publicUrl || !publicUrl.includes(cleanTaskId)) {
    throw new Error(`Public URL verification failed: URL '${publicUrl}' does not contain task id '${cleanTaskId}'`);
  }

  // 5. Single atomic statement:
  // UPDATE submission_tasks SET status='submitted', application_submitted_screenshot_url=:URL,
  // screenshot_path=:path, completed_at=now(), updated_at=now()
  // WHERE id=:taskId AND status='applying' AND worker_id=:workerId
  let updatedTask = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const now = new Date().toISOString();
    try {
      const { data: rows, error: updateErr } = await supabase
        .from('submission_tasks')
        .update({
          status: 'submitted',
          application_submitted_screenshot_url: publicUrl,
          screenshot_path: storagePath,
          completed_at: now,
          updated_at: now,
        })
        .eq('id', cleanTaskId)
        .eq('status', 'applying')
        .eq('worker_id', workerId)
        .select('*');

      if (updateErr) {
        lastErr = updateErr;
        console.warn(`[recordTaskSubmissionProof] Attempt ${attempt} failed: ${updateErr.message}. Retrying...`);
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      if (rows && rows.length > 0) {
        updatedTask = rows[0];
        break;
      } else {
        // Zero rows updated (could be worker lease race or status change)
        lastErr = new Error(`Zero rows updated. Task #${cleanTaskId} may not be in 'applying' state for worker ${workerId}`);
      }
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  if (!updatedTask) {
    throw (lastErr || new Error(`Failed to update task #${cleanTaskId} after ${maxRetries} attempts`));
  }

  console.log(`✅ [${workerId}] Submission proof recorded for Task #${cleanTaskId}:`);
  console.log(`   Path: ${storagePath}`);
  console.log(`   URL:  ${publicUrl}`);

  return {
    success: true,
    taskId: cleanTaskId,
    screenshotPath: storagePath,
    screenshotUrl: publicUrl,
    task: updatedTask,
  };
}
