import fs from 'fs';
import { canonicalizeWorkdayUrl } from '../lib/clusterBatchRunner.mjs';
import { ingestCsvToBatchQueue, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';

loadLocalEnvOnce();

function parseFile() {
  const filePath = './data/workday links for ajith.csv';
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    return [];
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const items = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    const rawUrl = line.slice(0, comma).trim();
    const rawIds = line.slice(comma + 1).replace(/^"|"$/g, '').trim();
    const ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);

    const { cleanUrl, tenant } = canonicalizeWorkdayUrl(rawUrl);
    let company = tenant || 'Workday Company';
    if (/unity/i.test(tenant)) company = 'Unity';
    else if (/lendingclub/i.test(tenant)) company = 'LendingClub';
    else if (/cambium/i.test(tenant)) company = 'Cambium Learning';
    else if (/allina/i.test(tenant)) company = 'Allina Health';
    else if (/bcbsms/i.test(tenant)) company = 'BCBSMS';
    else if (/centric/i.test(tenant)) company = 'Centric Software';
    else if (/relx/i.test(tenant)) company = 'RELX';
    else if (/generac/i.test(tenant)) company = 'Generac';
    else if (/etsy/i.test(tenant)) company = 'Etsy';
    else if (/visa/i.test(tenant)) company = 'Visa';
    else if (/uchicago/i.test(tenant)) company = 'UChicago';
    else if (tenant) company = tenant.charAt(0).toUpperCase() + tenant.slice(1);

    for (const applywizzId of ids) {
      items.push({
        applywizzId,
        jobUrl: cleanUrl || rawUrl,
        company,
        roleTitle: 'Job Application',
        status: 'pending',
      });
    }
  }
  return items;
}

async function run() {
  const items = parseFile();
  console.log(`Parsed ${items.length} items from CSV.`);
  const res = await ingestCsvToBatchQueue(items);
  console.log('Ingest result:', res);
}

run().catch(console.error);
