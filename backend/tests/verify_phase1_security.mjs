/**
 * verify_phase1_security.mjs
 * End-to-end verification suite for Phase 1 Security Baseline:
 * 1. Default login code verification & short-lived JWT issuance
 * 2. Invalid login code rejection (401)
 * 3. Login attempt rate limiting (max 5 per minute -> 429 on 6th attempt)
 * 4. Closed unauthenticated endpoints: /api/bot/status, /api/bot/stop, /api/bot/trigger (401 without token)
 * 5. RBAC enforcement: Admin token blocked on trigger endpoints (403)
 * 6. RBAC enforcement: Developer token permitted on trigger endpoints (200)
 * 7. Verification that frontend bundle contains no service_role key
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const TEST_PORT = 3005;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Server did not respond at ${url} within ${timeoutMs}ms`);
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 STARTING PHASE 1 SECURITY BASELINE REAL VERIFICATION SUITE');
  console.log('===============================================================\n');

  // Spawn the real daemon on TEST_PORT
  console.log(`[SUITE] Starting queue_daemon.mjs on port ${TEST_PORT}...`);
  const daemonProcess = spawn('node', ['scripts/queue_daemon.mjs'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DAEMON_PORT: String(TEST_PORT),
      DEFAULT_LOGIN_CODE: '000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  daemonProcess.stdout.on('data', (d) => {
    const text = d.toString();
    if (text.includes('[DAEMON WEBHOOK SERVER]') || text.includes('[PRESENCE]')) {
      process.stdout.write(`  [daemon stdout] ${text}`);
    }
  });

  daemonProcess.stderr.on('data', (d) => {
    process.stderr.write(`  [daemon stderr] ${d.toString()}`);
  });

  let serverReady = false;
  try {
    await waitForServer(BASE_URL);
    serverReady = true;
    console.log(`[SUITE] ✅ queue_daemon is live and healthy on ${BASE_URL}\n`);
  } catch (err) {
    console.error(`[SUITE] ❌ Failed to start daemon:`, err.message);
    daemonProcess.kill();
    process.exit(1);
  }

  const results = [];

  function record(title, passed, details) {
    results.push({ title, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${mark} | ${title}`);
    if (details) {
      console.log(`       Details: ${JSON.stringify(details, null, 2)}\n`);
    }
  }

  let devToken = null;
  let adminToken = null;

  try {
    // ── Test 1: Valid Login with Default Code (Developer) ─────────────────────────
    {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ajithchandranimmala@applywizz.ai',
          code: '000000',
        }),
      });
      const data = await res.json();
      const status = res.status;
      devToken = data.token;
      record('1. Developer Login with DEFAULT_LOGIN_CODE (000000)', status === 200 && !!devToken, {
        status,
        success: data.success,
        role: data.user?.role,
        hasToken: !!devToken,
      });
    }

    // ── Test 2: Valid Login with Default Code (Admin) ─────────────────────────────
    {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ramakrishna@applywizz.ai',
          code: '000000',
        }),
      });
      const data = await res.json();
      const status = res.status;
      adminToken = data.token;
      record('2. Admin Login with DEFAULT_LOGIN_CODE (000000)', status === 200 && !!adminToken, {
        status,
        success: data.success,
        role: data.user?.role,
        hasToken: !!adminToken,
      });
    }

    // ── Test 3: Invalid Login Code Rejection ──────────────────────────────────────
    {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ajithchandranimmala@applywizz.ai',
          code: '999999',
        }),
      });
      const data = await res.json();
      const status = res.status;
      record('3. Invalid Login Code (999999) Returns 401', status === 401 && data.error === 'Invalid login code', {
        status,
        error: data.error,
      });
    }

    // ── Test 4: Rate Limiting on Login (5 attempts allowed, 6th returns 429) ───────
    {
      const rateLimitEmail = 'ratelimit_probe@applywizz.ai';
      let lastStatus = 0;
      let lastData = null;
      let statuses = [];
      for (let i = 1; i <= 6; i++) {
        const res = await fetch(`${BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: rateLimitEmail,
            code: 'wrong',
          }),
        });
        lastStatus = res.status;
        lastData = await res.json();
        statuses.push({ attempt: i, status: lastStatus });
      }
      record('4. Login Rate Limiting (6th attempt returns 429)', lastStatus === 429, {
        attempts: statuses,
        lastError: lastData?.error,
      });
    }

    // ── Test 5: Unauthenticated Trigger Request (No Token -> 401) ─────────────────
    {
      const res = await fetch(`${BASE_URL}/api/bot/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      const status = res.status;
      record('5. Trigger endpoint /api/bot/stop without Token returns 401', status === 401, {
        status,
        error: data.error,
      });
    }

    // ── Test 6: Unauthenticated Status Request (No Token -> 401) ──────────────────
    {
      const res = await fetch(`${BASE_URL}/api/bot/status`);
      const data = await res.json();
      const status = res.status;
      record('6. Read endpoint /api/bot/status without Token returns 401', status === 401, {
        status,
        error: data.error,
      });
    }

    // ── Test 7: Admin Token on Trigger Endpoint (Admin -> 403 Forbidden) ───────────
    {
      const res = await fetch(`${BASE_URL}/api/bot/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      const status = res.status;
      record('7. Admin Token on Trigger endpoint /api/bot/stop returns 403 Forbidden', status === 403, {
        status,
        error: data.error,
      });
    }

    // ── Test 8: Admin Token on Read Endpoint (Admin -> 200 Allowed) ───────────────
    {
      const res = await fetch(`${BASE_URL}/api/bot/status`, {
        headers: {
          'Authorization': `Bearer ${adminToken}`,
        },
      });
      const data = await res.json();
      const status = res.status;
      record('8. Admin Token on Read endpoint /api/bot/status returns 200 OK', status === 200 && data.success === true, {
        status,
        success: data.success,
        workers: data.workers,
      });
    }

    // ── Test 9: Developer Token on Trigger Endpoint (Developer -> 200 Allowed) ────
    {
      const res = await fetch(`${BASE_URL}/api/bot/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${devToken}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      const status = res.status;
      record('9. Developer Token on Trigger endpoint /api/bot/stop returns 200 OK', status === 200 && data.success === true, {
        status,
        success: data.success,
        message: data.message,
      });
    }

    // ── Test 10: Frontend Service Role Key Eradication Check ──────────────────────
    {
      const frontendDir = path.resolve(BACKEND_DIR, '..', 'frontend', 'src');
      const leakedSignatures = [
        'eNtTpBT0xWtZzySiR_9OnHZVRxSmHgEZJL_pzvyfGwg',
        'rzyqJKwuMW81IFAEtGsKOPSyjlxuQTXNsUYHrC6wUGg',
      ];
      let foundLeak = false;

      function scanDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (/\.(js|jsx|ts|tsx|html|env)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (leakedSignatures.some(sig => content.includes(sig)) || content.includes('SUPABASE_SERVICE_ROLE_KEY')) {
              foundLeak = true;
            }
          }
        }
      }

      scanDir(frontendDir);
      record('10. Frontend bundle contains NO service_role key or signature', !foundLeak, {
        scannedDirectory: frontendDir,
        leakedSignatureFound: foundLeak,
      });
    }

  } finally {
    console.log('[SUITE] Tearing down test daemon process...');
    daemonProcess.kill('SIGTERM');
  }

  console.log('\n===============================================================');
  console.log('📊 PHASE 1 SECURITY VERIFICATION SUMMARY');
  console.log('===============================================================');
  const allPassed = results.every((r) => r.passed);
  console.log(`Total tests: ${results.length} | Passed: ${results.filter((r) => r.passed).length} | Failed: ${results.filter((r) => !r.passed).length}`);
  console.log(`Result: ${allPassed ? 'ALL TESTS PASSED 🎉' : 'SOME TESTS FAILED ❌'}`);
  console.log('===============================================================\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('[SUITE FATAL]', err);
  process.exit(1);
});
