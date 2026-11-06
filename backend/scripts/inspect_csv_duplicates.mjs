import { readFileSync } from 'fs';
import { resolve } from 'path';

const csvPath = resolve('Data/wd_jobs_202611061113.csv');
const content = readFileSync(csvPath, 'utf8');

function parseCSVLine(line = '') {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
const urlMap = new Map();

for (let r = 1; r < lines.length; r++) {
  const parts = parseCSVLine(lines[r]);
  const jobId = parts[1]?.trim();
  const company = parts[2]?.trim();
  const title = parts[3]?.trim();
  const url = parts[4]?.trim();
  const taskCount = parts[5]?.trim();
  const awlRaw = parts[6] || '';
  const awlIds = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());

  if (!urlMap.has(url)) urlMap.set(url, []);
  urlMap.get(url).push({ rowNumber: r + 1, jobId, company, title, taskCount, awlIds });
}

console.log('--- Duplicate URLs in CSV ---');
for (const [url, entries] of urlMap.entries()) {
  if (entries.length > 1) {
    console.log(`\nURL: ${url}`);
    console.log(`Appears in ${entries.length} different CSV rows:`);
    for (const e of entries) {
      console.log(`  - Excel Row ${e.rowNumber} | job_id: ${e.jobId} | Company: "${e.company}" | Title: "${e.title}" | Count: ${e.taskCount} | AWL IDs: ${e.awlIds.length} candidates`);
    }
    // Check if the AWL IDs in both rows are identical or different
    const awl1 = new Set(entries[0].awlIds);
    const awl2 = new Set(entries[1].awlIds);
    const inBoth = entries[0].awlIds.filter((id) => awl2.has(id));
    console.log(`    Overlap between both rows: ${inBoth.length} candidates in common (Row 1: ${awl1.size}, Row 2: ${awl2.size})`);
  }
}

