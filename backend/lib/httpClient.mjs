/**
 * httpClient.mjs — IPv4 HTTPS JSON helper.
 *
 * Node's global fetch prefers AAAA records. Several hosts (Apply Wizz,
 * OpenRouter) advertise IPv6/NAT64 first; Windows often dies with "fetch failed".
 */

import https from 'node:https';

/**
 * @param {Error} err
 * @returns {string}
 */
export function formatHttpError(err) {
  const cause = err?.cause;
  const parts = [err?.message, err?.code, cause?.code, cause?.message]
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' — ') || 'unknown network error';
}

export function isTlsCertError(err) {
  const blob = [err?.code, err?.cause?.code, err?.message, err?.cause?.message].join(' ');
  return /UNABLE_TO_VERIFY|CERT_|SELF_SIGNED|DEPTH_ZERO|unable to verify the first certificate/i.test(blob);
}

/**
 * @param {{ url: string, method?: string, headers?: object, body?: object|string|null, timeoutMs?: number, rejectUnauthorized?: boolean }} opts
 * @returns {Promise<{ status: number, ok: boolean, text: string, json: function(): * }>}
 */
export function httpsJsonRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 20000, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      family: 4,
      rejectUnauthorized,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'workday-auto-apply',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          text,
          json() {
            return JSON.parse(text);
          },
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {object} opts same as httpsJsonRequest
 * @param {{ attempts?: number, label?: string }} [retry]
 */
export async function httpsJsonWithRetry(opts, { attempts = 3, label = 'HTTP' } = {}) {
  const insecureOk = opts.rejectUnauthorized === false
    || String(process.env.APPLYWIZZ_TLS_INSECURE || process.env.NODE_TLS_INSECURE || '').trim() === '1';

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await httpsJsonRequest({
        ...opts,
        rejectUnauthorized: insecureOk ? false : opts.rejectUnauthorized,
      });
    } catch (err) {
      lastError = err;
      if (isTlsCertError(err) && !insecureOk && opts.rejectUnauthorized !== false) {
        console.log(`  ⚠️  ${label}: TLS verify failed — retrying without certificate verify (Windows/corporate CA)`);
        try {
          return await httpsJsonRequest({ ...opts, rejectUnauthorized: false });
        } catch (retryErr) {
          lastError = retryErr;
          console.log(`  ⚠️  ${label} insecure retry failed: ${formatHttpError(retryErr)}`);
        }
      } else {
        console.log(`  ⚠️  ${label} attempt ${attempt}/${attempts} failed: ${formatHttpError(err)}`);
      }
      if (attempt < attempts) {
        await new Promise((done) => setTimeout(done, 800 * attempt));
      }
    }
  }
  if (isTlsCertError(lastError) && opts.rejectUnauthorized !== false) {
    console.log(`  ⚠️  ${label}: certificate verify failed — final retry without verify`);
    return await httpsJsonRequest({ ...opts, rejectUnauthorized: false });
  }
  throw lastError;
}
