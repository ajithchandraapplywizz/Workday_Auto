import { signJwt } from 'file:///c:/Users/ajith/OneDrive/Desktop/New_Auto_Workday/backend/lib/authService.mjs';

async function testAcceptance() {
  console.log('=== ACCEPTANCE TEST C: HTTP AUTH TO /api/admin/dashboard ===\n');

  // 1. No token -> expect 401
  const resNoToken = await fetch('http://localhost:3001/api/admin/dashboard');
  const bodyNoToken = await resNoToken.json();
  console.log('1. No Token:');
  console.log(`   HTTP Status: ${resNoToken.status} (Expected: 401)`);
  console.log(`   Response:`, bodyNoToken);

  // 2. CA token -> expect 403
  const caToken = signJwt({ email: 'shravani@applywizz.com', role: 'ca', name: 'Shravani' });
  const resCa = await fetch('http://localhost:3001/api/admin/dashboard', {
    headers: { 'Authorization': `Bearer ${caToken}` }
  });
  const bodyCa = await resCa.json();
  console.log('\n2. CA Token:');
  console.log(`   HTTP Status: ${resCa.status} (Expected: 403)`);
  console.log(`   Response:`, bodyCa);

  // 3. Admin token -> expect 200 and JSON
  const adminToken = signJwt({ email: 'admin@applywizz.ai', role: 'admin', name: 'Admin User' });
  const resAdmin = await fetch('http://localhost:3001/api/admin/dashboard', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  const bodyAdmin = await resAdmin.json();
  console.log('\n3. Admin Token:');
  console.log(`   HTTP Status: ${resAdmin.status} (Expected: 200)`);
  console.log(`   Success: ${bodyAdmin.success}`);
  console.log(`   CAs Total: ${bodyAdmin.cas?.total}`);
  console.log(`   Managers:`, bodyAdmin.cas?.byManager);
  console.log(`   Presence:`, bodyAdmin.presence ? { active: bodyAdmin.presence.active, inactive: bodyAdmin.presence.inactive } : null);
  console.log(`   Tasks:`, bodyAdmin.tasks);
  console.log(`   Answer Sources:`, bodyAdmin.answerSources);
  console.log(`   Integrations:`, bodyAdmin.integrations);
  console.log(`   Reconciliation Excluded:`, bodyAdmin.reconciliation?.excluded);
  console.log(`   Range: ${bodyAdmin.range}`);
}

testAcceptance().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
