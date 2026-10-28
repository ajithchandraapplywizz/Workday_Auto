import { signJwt } from '../lib/authService.mjs';

async function testControls() {
  console.log('--- Phase 6: Testing Worker Controls Endpoints ---');
  const token = signJwt({ email: 'pintu@applywizz.com', role: 'developer' });

  // 1. GET /api/bot/controls
  const getRes = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());
  console.log('1. Initial GET /api/bot/controls:', getRes);

  // 2. POST /api/bot/controls: Start Scan
  const postScan = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'scan', action: 'start' })
  }).then(r => r.json());
  console.log('2. POST /api/bot/controls (Scan Start):', postScan);

  // 3. POST /api/bot/controls: Emergency Stop Scan (<500ms abort)
  const postStopScan = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'scan', action: 'stop' })
  }).then(r => r.json());
  console.log('3. POST /api/bot/controls (Scan Stop):', postStopScan);

  // 4. POST /api/bot/controls: Start Submit
  const postSubmit = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'submit', action: 'start' })
  }).then(r => r.json());
  console.log('4. POST /api/bot/controls (Submit Start):', postSubmit);

  // 5. POST /api/bot/controls: Stop Submit
  const postStopSubmit = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'submit', action: 'stop' })
  }).then(r => r.json());
  console.log('5. POST /api/bot/controls (Submit Stop):', postStopSubmit);

  // 6. Verify final state
  const finalGet = await fetch('http://127.0.0.1:3001/api/bot/controls', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());
  console.log('6. Final GET /api/bot/controls:', finalGet);
}

testControls().catch(console.error);
