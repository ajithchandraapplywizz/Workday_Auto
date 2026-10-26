import fs from 'fs';

const content = fs.readFileSync('expired_and_restarted_applications.csv', 'utf8');
const lines = content.trim().split('\n').slice(1);
const rows = lines.map(l => {
  const parts = l.split('","').map(p => p.replace(/^"|"$/g, ''));
  return {
    source: parts[0],
    id: parts[1],
    distId: parts[2],
    awlId: parts[3],
    company: parts[4],
    role: parts[5],
    status: parts[6],
    error: parts[7],
    url: parts[9]
  };
});

console.log('Total rows in CSV:', rows.length);
const urlMap = new Map();
for (const r of rows) {
  if (!urlMap.has(r.url)) urlMap.set(r.url, []);
  urlMap.get(r.url).push(r);
}

console.log(`Unique URLs (${urlMap.size}):`);
let idx = 1;
for (const [url, list] of urlMap.entries()) {
  console.log(`${idx++}. ${list[0].company} | ${list[0].role} | tasks: ${list.length} | URL: ${url}`);
}
