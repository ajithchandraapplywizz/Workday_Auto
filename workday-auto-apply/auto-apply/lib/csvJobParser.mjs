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
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim()); current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

export function parseClientJobsCsvContent(content = '') {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];

  const firstParts = parseCSVLine(lines[0]);
  const lowerFirst = firstParts.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ''));

  let idIdx = lowerFirst.findIndex((p) => ['applywizzid', 'awlid', 'clientid', 'candidateid', 'client'].includes(p));
  let urlIdx = lowerFirst.findIndex((p) => ['joburl', 'url', 'link', 'joblink'].includes(p));
  let companyIdx = lowerFirst.findIndex((p) => ['company', 'companyname', 'organization'].includes(p));
  let roleIdx = lowerFirst.findIndex((p) => ['role', 'title', 'roletitle', 'jobtitle'].includes(p));

  const hasHeader = idIdx !== -1 || urlIdx !== -1;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const results = [];
  const awlRegex = /\b(AWL[-_]?\d+)\b/i;
  const urlRegex = /https?:\/\/[^\s,"']+\.myworkdayjobs\.com[^\s,"']*/i;

  for (const line of dataLines) {
    const parts = parseCSVLine(line);
    if (!parts.length || (parts.length === 1 && !parts[0])) continue;

    let applywizzId = '';
    let jobUrl = '';
    let company = '';
    let roleTitle = '';

    if (hasHeader) {
      if (idIdx !== -1 && parts[idIdx]) applywizzId = parts[idIdx];
      if (urlIdx !== -1 && parts[urlIdx]) jobUrl = parts[urlIdx];
      if (companyIdx !== -1 && parts[companyIdx]) company = parts[companyIdx];
      if (roleIdx !== -1 && parts[roleIdx]) roleTitle = parts[roleIdx];
    }

    // Auto-detect if missing or headerless
    if (!applywizzId || !jobUrl) {
      for (const part of parts) {
        if (!applywizzId) {
          const matchAwl = part.match(awlRegex);
          if (matchAwl) applywizzId = matchAwl[1].toUpperCase();
        }
        if (!jobUrl) {
          const matchUrl = part.match(urlRegex);
          if (matchUrl) jobUrl = matchUrl[0];
        }
      }
    }

    if (applywizzId && jobUrl) {
      const cleanUrl = jobUrl.replace(/[)\].,;]+$/g, '').trim();
      const check = validateWorkdayUrl(cleanUrl);
      if (check.valid) {
        results.push({
          applywizzId: applywizzId.toUpperCase(),
          jobUrl: cleanUrl,
          company: company || undefined,
          roleTitle: roleTitle || undefined,
        });
      }
    }
  }

  return results;
}

export async function readClientJobsCsvFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return parseClientJobsCsvContent(content);
}
