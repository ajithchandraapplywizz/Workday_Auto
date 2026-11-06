import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const csvPath = resolve('Data/wd_jobs_202611061113.csv');
console.log('CSV exists:', existsSync(csvPath));

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

const raw = readFileSync(csvPath, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
console.log(`Total non-empty lines: ${lines.length}`);
console.log('Header line:', parseCSVLine(lines[0]));

const urlMap = new Map();
let totalCandidatesCount = 0;

for (let i = 1; i < lines.length; i++) {
  const parts = parseCSVLine(lines[i]);
  if (parts.length < 5) continue;
  const jobId = parts[1] ? parts[1].trim() : null;
  const company = parts[2] ? parts[2].trim() : '';
  const roleTitle = parts[3] ? parts[3].trim() : '';
  const jobUrl = parts[4] ? parts[4].trim() : '';
  const taskCount = parseInt(parts[5], 10) || 0;
  const awlRaw = parts[6] || '';

  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) continue;

  const awlMatches = [...awlRaw.matchAll(/\b(AWL[-_]?\d+)\b/gi)].map((m) => m[1].toUpperCase());
  const uniqueAwl = [...new Set(awlMatches)];

  if (!urlMap.has(jobUrl)) {
    urlMap.set(jobUrl, {
      job_id: jobId,
      company,
      role_title: roleTitle,
      job_url: jobUrl,
      awlIds: new Set(uniqueAwl),
    });
  } else {
    const existing = urlMap.get(jobUrl);
    for (const a of uniqueAwl) {
      existing.awlIds.add(a);
    }
  }
}

console.log(`\nAggregated into ${urlMap.size} unique Workday job URLs.`);

let singleCandidateCount = 0;
let multiCandidateCount = 0;
for (const [url, item] of urlMap.entries()) {
  totalCandidatesCount += item.awlIds.size;
  if (item.awlIds.size > 1) multiCandidateCount++;
  else singleCandidateCount++;
}

console.log(`Total candidate associations: ${totalCandidatesCount}`);
console.log(`Links with > 1 candidate: ${multiCandidateCount}`);
console.log(`Links with 1 candidate: ${singleCandidateCount}`);

console.log('\nSample 3 aggregated rows:');
let count = 0;
for (const [url, item] of urlMap.entries()) {
  if (count++ >= 3) break;
  console.log({
    job_id: item.job_id,
    company: item.company,
    role_title: item.role_title,
    job_url: item.job_url,
    candidateCount: item.awlIds.size,
    sampleAwl: Array.from(item.awlIds).slice(0, 5),
  });
}

