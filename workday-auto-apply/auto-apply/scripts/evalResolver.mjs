import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csvParser from 'csv-parser';
import { resolveIntent } from '../lib/intentResolver.mjs';
import { retrieveEvidence } from '../lib/evidenceRetriever.mjs';
import { validateAnswer } from '../lib/answerValidator.mjs';
import { askLlmFallback } from '../lib/llmFallback.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const csvPath = path.resolve(__dirname, '../data/client_questions_rows.csv');

// Default is offline. Use --llm to enable live llm queries.
const args = process.argv.slice(2);
const enableLlm = args.includes('--llm');

async function runEval() {
  const rows = [];
  
  if (fs.existsSync(csvPath)) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csvParser())
        .on('data', (data) => rows.push(data))
        .on('end', resolve)
        .on('error', reject);
    });
  } else {
    console.warn(`CSV not found at ${csvPath}.`);
    return;
  }

  let totalQuestions = 0;
  let resolvedByTier = { 1: 0, 2: 0, 3: 0, llm: 0 };
  let queuedCount = 0;
  let falseAnswers = 0; // The holy grail gate: must be 0
  let noEvidenceClients = new Set();
  
  const intentFails = {};
  const allClients = new Set();
  const clientsWithEvidence = new Set();

  console.log(`Starting Eval. Enable LLM: ${enableLlm}. Total Rows: ${rows.length}`);

  for (const row of rows) {
    const candidateId = row.candidate_id;
    const tenant = row.tenant || 'eval_tenant';
    const rawLabel = row.label || row.question_text || '';
    const rawExpected = row.expected_answer;
    
    if (!candidateId) continue;
    allClients.add(candidateId);
    
    totalQuestions++;

    const fieldDescriptor = {
      label: rawLabel,
      elementType: row.element_type || 'input',
      role: row.role || 'textbox'
    };

    const liveOptions = row.options ? row.options.split('|') : [];

    // 1. Resolve Intent
    const { intent, controlType, confidence } = await resolveIntent(fieldDescriptor);
    if (!intent) {
      queuedCount++;
      intentFails[rawLabel] = (intentFails[rawLabel] || 0) + 1;
      continue;
    }

    // 2. Retrieve Evidence
    const evidenceObj = await retrieveEvidence(candidateId, tenant, intent);
    let candidateFacts = []; // Used if fallback triggered

    let answerVal = null;
    let tier = null;
    let ok = false;

    if (evidenceObj.status === 'found') {
      clientsWithEvidence.add(candidateId);
      answerVal = evidenceObj.value;
      tier = evidenceObj.tier;
      ok = true;
    } else if (evidenceObj.status === 'unavailable') {
      queuedCount++;
      continue;
    } else {
      // no_evidence. Trigger LLM fallback if enabled
      if (enableLlm) {
        const fbRes = await askLlmFallback(candidateId, tenant, intent, fieldDescriptor, liveOptions, candidateFacts);
        if (fbRes.ok) {
          answerVal = fbRes.answer;
          tier = 'llm';
          ok = true;
        } else {
          queuedCount++;
          continue;
        }
      } else {
        queuedCount++;
        continue;
      }
    }

    // 3. Validate
    if (ok) {
      const valRes = validateAnswer({ value: answerVal, source: 'eval' }, fieldDescriptor, liveOptions, {});
      if (valRes.ok) {
        resolvedByTier[tier]++;
        if (rawExpected && String(valRes.adjustedValue).toLowerCase() !== String(rawExpected).toLowerCase()) {
           // We might need a fuzzier check for expected vs adjusted, but for strictness:
           falseAnswers++;
        }
      } else {
        queuedCount++;
      }
    }
  }

  // Calculate missing clients
  for (const c of allClients) {
    if (!clientsWithEvidence.has(c)) {
      noEvidenceClients.add(c);
    }
  }

  // Report
  const coverage = totalQuestions === 0 ? 0 : Math.round(((totalQuestions - queuedCount) / totalQuestions) * 100);
  console.log('\n=== OFFLINE EVAL REPORT ===');
  console.log(`Total Questions: ${totalQuestions}`);
  console.log(`Overall Coverage: ${coverage}%`);
  console.log(`Queued (Unknown): ${queuedCount}`);
  console.log(`FALSE ANSWERS: ${falseAnswers} (MUST BE 0)`);
  
  console.log('\nResolved By Tier:');
  console.log(`  Tier 1 (QA Cache): ${resolvedByTier[1]}`);
  console.log(`  Tier 2 (CRM):      ${resolvedByTier[2]}`);
  console.log(`  Tier 3 (Resume):   ${resolvedByTier[3]}`);
  console.log(`  LLM Fallback:      ${resolvedByTier.llm}`);

  console.log(`\nClients with Zero Evidence: ${noEvidenceClients.size}`);
  
  console.log('\nTop Unresolved Intents/Labels:');
  const sortedFails = Object.entries(intentFails).sort((a, b) => b[1] - a[1]).slice(0, 10);
  sortedFails.forEach(([label, count]) => {
    console.log(`  - [${count}x] ${label}`);
  });
}

runEval().catch(console.error);
