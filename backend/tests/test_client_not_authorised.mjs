/**
 * test_client_not_authorised.mjs
 * S5a-2 Addendum Item 2: Test real client company_email from clients table on check-email and login
 * Expects { state: 'not_authorised' } on check-email and 403 { state: 'not_authorised' } on login.
 */

import http from 'node:http';
import { handleAuthRequest } from '../lib/authService.mjs';

const PORT = 3089;
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let body = {};
  if (req.method === 'POST') {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const rawText = Buffer.concat(buffers).toString();
    if (rawText) {
      try { body = JSON.parse(rawText); } catch {}
    }
  }

  if (parsedUrl.pathname.startsWith('/api/auth/')) {
    return handleAuthRequest(req, res, parsedUrl.pathname, body);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[TEST SERVER] Running on port ${PORT}`);
  const clientEmail = 'vishwas.boddu@applywizard.ai';

  try {
    // 1. check-email test
    console.log('\n--- TEST 1: POST /api/auth/check-email with client company_email ---');
    const checkRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail }),
    });
    const checkStatus = checkRes.status;
    const checkData = await checkRes.json();
    console.log(`HTTP Status: ${checkStatus}`);
    console.log(`Response Body: ${JSON.stringify(checkData, null, 2)}`);

    // 2. login test
    console.log('\n--- TEST 2: POST /api/auth/login with client company_email ---');
    const loginRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, code: '123456' }),
    });
    const loginStatus = loginRes.status;
    const loginData = await loginRes.json();
    console.log(`HTTP Status: ${loginStatus}`);
    console.log(`Response Body: ${JSON.stringify(loginData, null, 2)}`);

    console.log('\n--- TEST 3: POST /api/auth/logout with Bearer token ---');
    // Test logout requires token
    const logoutNoTokenRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fake@applywizz.com' }), // Body email must be ignored
    });
    console.log(`Logout Without Token Status: ${logoutNoTokenRes.status}`);
    console.log(`Logout Without Token Body: ${JSON.stringify(await logoutNoTokenRes.json())}`);

  } catch (err) {
    console.error('Test execution error:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
