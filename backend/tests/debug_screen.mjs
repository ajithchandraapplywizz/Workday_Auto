import { chromium } from 'playwright';

async function test() {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage();
  p.on('console', msg => console.log('PAGE LOG:', msg.text()));
  p.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  await p.goto('http://localhost:5182');
  await p.fill('#login-email', 'dayakar@applywizz.com');
  await p.click('button:has-text("Continue")');
  await p.waitForTimeout(3000);
  const text = await p.innerText('body');
  console.log('BODY TEXT:\n', text);
  await b.close();
}

test().catch(console.error);
