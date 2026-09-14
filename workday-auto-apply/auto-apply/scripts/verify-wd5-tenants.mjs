/**
 * Verifies WD5 tenant manifest matches override YAML files and URL routing.
 * Run from auto-apply/: node scripts/verify-wd5-tenants.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { detectWorkdayTenant, getWorkdayTenant } from '../lib/discovery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'config', 'wd5-tenants.json'), 'utf-8'));

let errors = 0;

for (const tenant of manifest.tenants) {
  const overridePath = resolve(ROOT, tenant.overrideFile);
  if (!existsSync(overridePath)) {
    console.error(`MISSING: ${tenant.overrideFile}`);
    errors++;
    continue;
  }

  const doc = yaml.load(readFileSync(overridePath, 'utf-8')) || {};
  const rules = doc.field_overrides || doc.field_map || [];
  if (!Array.isArray(rules) || rules.length === 0) {
    console.error(`EMPTY field_overrides: ${tenant.overrideFile}`);
    errors++;
  }

  const sampleUrl = `https://${tenant.host}/en-US/Careers/job/Test_123`;
  const resolved = getWorkdayTenant(sampleUrl);
  if (resolved !== tenant.slug) {
    console.error(`TENANT MISMATCH: ${tenant.slug} expected, got ${resolved} for ${sampleUrl}`);
    errors++;
  }

  for (const platform of ['wd1', 'wd3', 'wd5', 'wd12']) {
    const sample = `https://${tenant.slug}.${platform}.myworkdayjobs.com/en-US/Careers/job/Test_123`;
    const parsed = detectWorkdayTenant(sample);
    if (!parsed || parsed.tenant !== tenant.slug || parsed.platform !== platform) {
      console.error(`PLATFORM ROUTING FAIL: ${sample} → ${JSON.stringify(parsed)}`);
      errors++;
    }
  }

  for (const url of doc.scan_urls || []) {
    if (!/^https?:\/\//i.test(String(url))) continue;
    const fromScan = getWorkdayTenant(url);
    if (fromScan !== tenant.slug) {
      console.error(`SCAN URL TENANT MISMATCH: ${tenant.overrideFile} url tenant=${fromScan} expected=${tenant.slug}`);
      errors++;
    }
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s).`);
  process.exit(1);
}

console.log(`OK: ${manifest.count} WD5 tenants — files exist, field_overrides present, URL routing matches.`);
