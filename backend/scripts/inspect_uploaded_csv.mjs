import fs from 'fs';

const content = fs.readFileSync('data/workday links for ajith.csv', 'utf8');
const lines = content.split(/\r?\n/).filter(Boolean);
console.log('Total lines in CSV:', lines.length);

function parseCsvLine(line) {
  const parts = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts;
}

const urlMap = new Map();

for (let i = 1; i < lines.length; i++) {
  const [jobUrl, awlIdsStr] = parseCsvLine(lines[i]);
  if (!jobUrl || !awlIdsStr) continue;
  const cleanUrl = jobUrl.trim().replace(/^["']|["']$/g, '');
  const awlIds = awlIdsStr
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  if (!urlMap.has(cleanUrl)) {
    urlMap.set(cleanUrl, new Set());
  }
  const clientSet = urlMap.get(cleanUrl);
  for (const id of awlIds) {
    clientSet.add(id);
  }
}

console.log('Total unique URLs found:', urlMap.size);

const moreThan5 = [];
const fiveOrLess = [];

for (const [url, clients] of urlMap.entries()) {
  const count = clients.size;
  if (count > 5) {
    moreThan5.push({ url, count, clients: Array.from(clients) });
  } else {
    fiveOrLess.push({ url, count, clients: Array.from(clients) });
  }
}

console.log(`\n========================================`);
console.log(`✅ URLs with > 5 clients: ${moreThan5.length}`);
console.log(`❌ URLs with <= 5 clients (SKIPPED): ${fiveOrLess.length}`);
console.log(`========================================\n`);

let totalClientsToUpload = 0;
for (const item of moreThan5) {
  totalClientsToUpload += item.count;
  console.log(`• [${item.count} clients] ${item.url}`);
}

console.log(`\nTotal client-job tasks to upload: ${totalClientsToUpload}`);

console.log(`\nSkipped URLs (<= 5 clients):`);
for (const item of fiveOrLess) {
  console.log(`• [${item.count} clients] ${item.url}`);
}
