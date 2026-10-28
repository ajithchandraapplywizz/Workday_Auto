import { chromium } from 'playwright';
import { signMfaJwt } from '../lib/mfaAuth.mjs';

async function debugAdmin() {
  const adminToken = signMfaJwt({ id: 'admin-uuid', email: 'admin@applywizz.com', role: 'admin' });
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage();
  p.on('console', msg => console.log('PAGE LOG:', msg.text()));
  p.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  await p.goto('http://localhost:5182');
  await p.evaluate(({ token, adminUser }) => {
    localStorage.setItem('applywizz_auth_token', token);
    localStorage.setItem('applywizz_auth_session', JSON.stringify(adminUser));
  }, {
    token: adminToken,
    adminUser: {
      id: 'admin-uuid',
      email: 'admin@applywizz.com',
      role: 'admin',
      baseRole: 'admin',
      name: 'System Admin',
    },
  });

  await p.reload();
  await p.waitForTimeout(4000);
  const text = await p.innerText('body');
  console.log('ADMIN PAGE BODY TEXT:\n', text);
  await b.close();
}

debugAdmin().catch(console.error);
