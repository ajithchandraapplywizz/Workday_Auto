import fs from 'node:fs';
import path from 'node:path';
import { getLatestTraceFilePath } from '../lib/trace.mjs';

export function analyzeTraceLog(traceFilePath) {
  const file = traceFilePath || getLatestTraceFilePath();
  if (!fs.existsSync(file)) {
    console.log(`❌ No trace file found at: ${file}`);
    return null;
  }

  console.log(`\n============================================================`);
  console.log(`🔍 ANALYZING TRACE LOG: ${file}`);
  console.log(`============================================================\n`);

  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  const fieldEvents = events.filter((e) => e.stage === 'field_trace' || e.stage === 'verify');
  console.log(`Total trace events recorded: ${events.length}`);
  console.log(`Total field interactions: ${fieldEvents.length}\n`);

  // Check 1: Any field classified as wrong control type (dropdown flagged as text or vice versa)
  console.log(`--- CHECK 1: Control Type Classification ---`);
  const typeAnomalies = [];
  for (const e of fieldEvents) {
    const label = (e.label || '').toLowerCase();
    const type = (e.controlType || e.fieldType || '').toLowerCase();
    const aid = (e.automationId || '').toLowerCase();

    const labelSuggestsDropdown = /country|state|gender|pronoun|veteran|disability|race|ethnicity|select|hear about|source/i.test(label);
    const aidSuggestsDropdown = /select|dropdown|prompt|combobox/i.test(aid);
    const isFlaggedText = /text|input|textarea/.test(type);

    const labelSuggestsText = /first name|last name|email|phone|city|postal|zip|address|salary|gpa/i.test(label);
    const isFlaggedDropdown = /dropdown|select|combobox/.test(type);

    if ((labelSuggestsDropdown || aidSuggestsDropdown) && isFlaggedText && !/city|address|postal/.test(label)) {
      typeAnomalies.push({ event: e, reason: `Expected dropdown/select, but classified as "${type}"` });
    } else if (labelSuggestsText && isFlaggedDropdown && !/country|phone code/.test(label)) {
      typeAnomalies.push({ event: e, reason: `Expected text, but classified as "${type}"` });
    }
  }

  if (typeAnomalies.length === 0) {
    console.log(`✅ No control type classification mismatches detected.`);
  } else {
    console.log(`⚠️  Detected ${typeAnomalies.length} possible control type classification mismatch(es):`);
    for (const a of typeAnomalies) {
      console.log(`   - [${a.event.automationId}] "${a.event.label}" -> ${a.reason}`);
    }
  }

  // Check 2: Any field where a tier resolved a value but fill failed or didn't change page state
  console.log(`\n--- CHECK 2: Resolution Succeeded but Fill Failed / Verification Mismatch ---`);
  const fillFailures = [];
  for (const e of fieldEvents) {
    if (e.success === false || e.ok === false) {
      fillFailures.push(e);
    }
  }

  if (fillFailures.length === 0) {
    console.log(`✅ All resolved fields filled and verified successfully.`);
  } else {
    console.log(`⚠️  Detected ${fillFailures.length} failed fill/verify event(s):`);
    for (const f of fillFailures) {
      console.log(`   - [${f.automationId || f.questionId}] "${f.label}" | tier: ${f.tier || f.source} | val: "${f.valueAttempted || f.expected}" | reason: ${f.reason || 'unverified'}`);
    }
  }

  // Check 3: Any field where LLM answered even though Supabase/CRM/resume should have had it
  console.log(`\n--- CHECK 3: Tier Routing (LLM used where Supabase/CRM/Resume should have answered) ---`);
  const llmOveruse = [];
  for (const e of fieldEvents) {
    const tier = (e.tier || e.source || '').toLowerCase();
    const label = (e.label || '').toLowerCase();
    const isLlm = /llm|openrouter/.test(tier);

    // Identity, contact, work auth, EEO, standard resume items should NEVER be LLM
    const standardDeterministic = /first\s*name|last\s*name|full\s*name|email|phone|postal|zip|city|state|country|authorized to work|sponsorship|veteran|disability|gender|race|ethnicity/i.test(label);

    if (isLlm) {
      if (standardDeterministic) {
        llmOveruse.push({ event: e, severity: 'HIGH', reason: `LLM answered standard profile/contact/compliance question: "${e.label}"` });
      } else {
        llmOveruse.push({ event: e, severity: 'INFO', reason: `LLM answered question: "${e.label}"` });
      }
    }
  }

  if (llmOveruse.length === 0) {
    console.log(`✅ No unexpected LLM resolutions detected.`);
  } else {
    console.log(`Found ${llmOveruse.length} LLM resolution(s):`);
    for (const item of llmOveruse) {
      console.log(`   - [${item.severity}] aid="${item.event.automationId}" | label="${item.event.label}" | val="${item.event.valueAttempted || item.event.answer}" (${item.reason})`);
    }
  }

  console.log(`\n============================================================\n`);
  return { typeAnomalies, fillFailures, llmOveruse, totalEvents: events.length };
}

// If run directly:
if (process.argv[1] && process.argv[1].endsWith('pull-trace.mjs')) {
  const argFile = process.argv[2];
  analyzeTraceLog(argFile);
}
