import { readFileSync } from 'fs';
import { resolve } from 'path';

const csvPath = resolve('Data/wd_jobs_202611061113.csv');
const content = readFileSync(csvPath, 'utf8');

// 1. Regex search for all URLs
const urlMatches = content.match(/https?:\/\/[^\s,"']+/g) || [];
const uniqueUrls = [...new Set(urlMatches.map((u) => u.trim()))];
console.log(`Regex: Total URLs = ${urlMatches.length}, Unique URLs = ${uniqueUrls.length}`);

// 2. Let's parse with a proper multiline-aware CSV parser
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      currentRow.push(currentField);
      if (currentRow.some((f) => f.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows;
}

const parsed = parseCSV(content);
console.log(`Multiline CSV Parser: Found ${parsed.length} total rows (including header)`);
console.log('Header:', parsed[0]);

const byJobId = new Map();
const byUrl = new Map();

for (let r = 1; r < parsed.length; r++) {
  const row = parsed[r];
  const jobId = row[1]?.trim();
  const company = row[2]?.trim();
  const title = row[3]?.trim();
  const url = row[4]?.trim();
  const taskCount = row[5]?.trim();
  const awlRaw = row[6]?.trim();

  if (jobId) {
    if (!byJobId.has(jobId)) byJobId.set(jobId, []);
    byJobId.get(jobId).push({ rowIdx: r, company, title, url, taskCount, awlRaw });
  }
  if (url) {
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push({ rowIdx: r, jobId, company, title, taskCount, awlRaw });
  }
}

console.log(`Unique job_ids in CSV: ${byJobId.size}`);
console.log(`Unique URLs in CSV: ${byUrl.size}`);

// Print all unique job_ids and check why there might be 32
console.log('\n--- All Unique Job IDs in CSV ---');
let i = 1;
for (const [id, entries] of byJobId.entries()) {
  console.log(`${i++}. ID: ${id} | Company: "${entries[0].company}" | Title: "${entries[0].title}" | Rows: ${entries.length} | URL: ${entries[0].url}`);
}

