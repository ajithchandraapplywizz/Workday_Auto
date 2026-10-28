/**
 * run_auth_server.mjs — Dedicated Isolated Test Server for Auth Endpoints
 * ======================================================================
 * Runs exclusively the auth handlers on test port 3088 for safe live curl testing.
 */

import http from 'node:http';
import { handleAuthRequest } from '../lib/authService.mjs';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let body = {};
  if (req.method === 'POST') {
    try {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const rawText = Buffer.concat(buffers).toString();
      if (rawText) {
        try {
          body = JSON.parse(rawText);
        } catch (e) {
          console.log('[DEBUG SERVER JSON ERROR]', e.message, 'rawText was:', JSON.stringify(rawText));
        }
      }
    } catch { }
  }

  if (parsedUrl.pathname.startsWith('/api/auth/')) {
    return handleAuthRequest(req, res, parsedUrl.pathname, body);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TEST AUTH SERVER] Running on http://127.0.0.1:${PORT}`);
});
