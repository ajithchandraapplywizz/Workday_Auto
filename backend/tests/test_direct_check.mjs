import { handleCheckEmail } from '../lib/mfaAuth.mjs';

async function test() {
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writeHead(code, h) { this.code = code; },
    end(str) { console.log('Response:', this.code, str); }
  };
  await handleCheckEmail(req, res, { email: 'sana@applywizz.com' });
}
test();
