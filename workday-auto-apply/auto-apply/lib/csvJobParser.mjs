/**
 * csvJobParser.mjs — Robust parser for multi-client job CSVs
 *
 * Supports flexible headers:
 * - Client ID: applywizz_id, awl_id, client_id, candidate_id, client
 * - URL: job_url, url, link, job_link
 * - Company / Role: company, role, role_title
 * Also supports headerless CSVs by auto-detecting AWL pattern and Workday URLs.
 */

import { readFile } from 'fs/promises';
import { validateWorkdayUrl } from './discovery.mjs';

function parseCSVLine(line = '') {
  if (line.includes('\t')) {
    return line.split('\t').map((p) => p.trim().replace(/^["']|["']$/g, ''));
  }
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim().replace(/^["']|["']$/g, '')); current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim().replace(/^["']|["']$/g, ''));
  return parts;
}

export function parseClientJobsCsvContent(content = '') {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];

  const firstParts = parseCSVLine(lines[0]);
  const lowerFirst = firstParts.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''));

  let idIdx = lowerFirst.findIndex((p) => ['applywizzid', 'awlid', 'clientid', 'candidateid', 'client', 'clients', 'awlids'].includes(p));
  let urlIdx = lowerFirst.findIndex((p) => ['joburl', 'url', 'link', 'joblink'].includes(p));
  let companyIdx = lowerFirst.findIndex((p) => ['company', 'companyname', 'organization'].includes(p));
  let roleIdx = lowerFirst.findIndex((p) => ['role', 'title', 'roletitle', 'jobtitle'].includes(p));

  const hasHeader = idIdx !== -1 || urlIdx !== -1;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const results = [];
  const awlRegex = /\b(AWL[-_]?\d+)\b/gi;
  const urlRegex = /https?:\/\/[^\s,"'\t]+\.myworkdayjobs\.com[^\s,"'\t]*/i;

  for (const line of dataLines) {
    const parts = parseCSVLine(line);
    if (!parts.length || (parts.length === 1 && !parts[0])) continue;

    let explicitIdPart = '';
    let jobUrl = '';
    let company = '';
    let roleTitle = '';

    if (hasHeader) {
      if (idIdx !== -1 && parts[idIdx]) explicitIdPart = parts[idIdx];
      if (urlIdx !== -1 && parts[urlIdx]) jobUrl = parts[urlIdx];
      if (companyIdx !== -1 && parts[companyIdx]) company = parts[companyIdx];
      if (roleIdx !== -1 && parts[roleIdx]) roleTitle = parts[roleIdx];
    }

    // Extract ALL AWL IDs from the line or ID column (supports comma-separated list of 40+ clients!)
    let awlList = [];
    if (explicitIdPart) {
      const matches = [...explicitIdPart.matchAll(awlRegex)].map((m) => m[1].toUpperCase());
      if (matches.length > 0) awlList = matches;
    }

    // Auto-detect if missing or headerless
    if (!jobUrl || !awlList.length) {
      for (const part of parts) {
        if (!jobUrl) {
          const matchUrl = part.match(urlRegex);
          if (matchUrl) jobUrl = matchUrl[0];
        }
        if (!awlList.length) {
          const matches = [...part.matchAll(awlRegex)].map((m) => m[1].toUpperCase());
          if (matches.length > 0) awlList = matches;
        }
      }
    }

    // Full line fallback for unescaped rows
    if (!awlList.length) {
      const lineMatches = [...line.matchAll(awlRegex)].map((m) => m[1].toUpperCase());
      if (lineMatches.length > 0) awlList = lineMatches;
    }
    if (!jobUrl) {
      const lineUrl = line.match(urlRegex);
      if (lineUrl) jobUrl = lineUrl[0];
    }

    if (awlList.length > 0 && jobUrl) {
      const cleanUrl = jobUrl.replace(/[)\].,;]+$/g, '').trim();
      const check = validateWorkdayUrl(cleanUrl);
      if (check.valid) {
        // Deduplicate AWL IDs in this row
        const uniqueAwls = [...new Set(awlList)];
        for (const applywizzId of uniqueAwls) {
          results.push({
            applywizzId,
            jobUrl: cleanUrl,
            company: company || undefined,
            roleTitle: roleTitle || undefined,
          });
        }
      }
    }
  }

  return results;
}

export async function readClientJobsCsvFile(filePath, { minClients = 1 } = {}) {
  const content = await readFile(filePath, 'utf-8');
  const tasks = parseClientJobsCsvContent(content);
  if (minClients > 1) {
    const { qualifying } = groupAndFilterByMinClients(tasks, minClients);
    return qualifying;
  }
  return tasks;
}

/**
 * Group CSV tasks by canonical job URL and filter for links appearing for >= minClients.
 * @param {Array<{ applywizzId: string, jobUrl: string }>} tasks
 * @param {number} minClients
 */
export function groupAndFilterByMinClients(tasks = [], minClients = 30) {
  const normalize = (u = '') => {
    return String(u || '').trim()
      .replace(/\/(apply(\/.*)?|applicationSubmitted(\/.*)?|jobTasks(\/.*)?)$/i, '')
      .replace(/%2C/gi, ',');
  };

  const groups = new Map();
  for (const t of tasks) {
    const normUrl = normalize(t.jobUrl);
    if (!groups.has(normUrl)) {
      groups.set(normUrl, []);
    }
    groups.get(normUrl).push(t);
  }

  const qualifying = [];
  const linkStats = [];

  for (const [normUrl, clientTasks] of groups.entries()) {
    const count = clientTasks.length;
    linkStats.push({
      jobUrl: normUrl,
      clientCount: count,
      meetsThreshold: count >= minClients,
    });
    if (count >= minClients) {
      qualifying.push(...clientTasks);
    }
  }

  // Sort descending by client count
  linkStats.sort((a, b) => b.clientCount - a.clientCount);

  return {
    qualifying: qualifying.length ? qualifying : (minClients <= 1 ? tasks : []),
    groups,
    linkStats,
    totalOriginalTasks: tasks.length,
    totalUniqueLinks: groups.size,
    qualifyingLinksCount: linkStats.filter((s) => s.meetsThreshold).length,
    qualifyingTasksCount: qualifying.length,
  };
}
