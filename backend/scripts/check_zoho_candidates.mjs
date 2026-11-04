import { listZohoUsers } from '../lib/zohoMailClient.mjs';
import { fetchApplyWizzClient, resolveCompanyEmail } from '../lib/applyWizzClient.mjs';

async function check() {
  const users = await listZohoUsers();
  const zohoEmails = new Set((users || []).filter(u => u.connected).map(u => u.email?.toLowerCase()));
  console.log(`Total active Zoho mailboxes: ${zohoEmails.size}`);

  const candidates = [
    'AWL-24852', 'AWL-26023', 'AWL-27613', 'AWL-27855', 'AWL-29710',
    'AWL-29927', 'AWL-29945', 'AWL-30424', 'AWL-31114', 'AWL-31243',
    'AWL-31424', 'AWL-31474', 'AWL-31813', 'AWL-31880', 'AWL-32063',
    'AWL-32411', 'AWL-32458', 'AWL-32933', 'AWL-32982', 'AWL-33095',
    'AWL-33238', 'AWL-34779', 'AWL-35033', 'AWL-35198', 'AWL-35252',
    'AWL-36019', 'AWL-36100', 'AWL-36883', 'AWL-3762', 'AWL-39618',
    'AWL-42043', 'AWL-42670', 'AWL-42673', 'AWL-43089', 'AWL-43537',
    'AWL-44161', 'AWL-44770', 'AWL-4593', 'AWL-46046', 'AWL-6307'
  ];

  for (const cid of candidates) {
    try {
      const client = await fetchApplyWizzClient(cid);
      const email = resolveCompanyEmail(client?.client || {}, client?.client?.full_name);
      const inZoho = zohoEmails.has(email?.toLowerCase());
      if (inZoho) {
        console.log(`🎯 MATCH FOUND: ${cid} -> ${client?.client?.full_name} (${email})`);
        break;
      }
    } catch {}
  }
}

check().catch(console.error);

