import { request, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
loadLocalEnvOnce();
const clients = await request('clients', { query: '?select=id,applywizz_id,name,email&limit=5' });
console.log('Sample clients:', clients);
