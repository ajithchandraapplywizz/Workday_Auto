#!/usr/bin/env node
/**
 * store-required-fields.mjs — Persist / inspect required DOM fields DB.
 *
 * Usage:
 *   node scripts/store-required-fields.mjs list
 *   node scripts/store-required-fields.mjs path
 *
 * During apply, required questions are auto-stored by answerPipeline /
 * dynamicFieldEngine with field_type_code:
 *   1=input  2=dropdown  3=radio  4=checkbox  5=multi_checkbox
 *
 * Answer order at runtime:
 *   DB/YAML → resume parse → Apply Wizz + LLM (full client profile, humanic)
 */

import { dumpRequiredFieldsStore, getRequiredFieldsDbPath, isRequiredFieldsDbPresent } from '../lib/requiredFieldStore.mjs';
import { FIELD_TYPE_CODE_LABELS } from '../lib/fieldTypeCodes.mjs';

const cmd = String(process.argv[2] || 'list').toLowerCase();

if (cmd === 'path') {
  console.log(getRequiredFieldsDbPath());
  process.exit(0);
}

if (!isRequiredFieldsDbPresent()) {
  console.log(`No DB yet at ${getRequiredFieldsDbPath()}`);
  console.log('Run an apply — required DOM fields are stored automatically.');
  process.exit(0);
}

const store = await dumpRequiredFieldsStore();
const rows = Object.values(store.fields || {});
console.log(`Required fields DB: ${getRequiredFieldsDbPath()}`);
console.log(`Updated: ${store.updated_at || '—'} | entries: ${rows.length}\n`);

for (const row of rows.sort((a, b) => String(a.label).localeCompare(String(b.label)))) {
  const code = row.field_type_code ?? '?';
  const name = FIELD_TYPE_CODE_LABELS[code] || row.field_type || 'input';
  const ans = row.answer != null && row.answer !== '' ? String(row.answer).slice(0, 60) : '(no answer yet)';
  console.log(`[${code}:${name}] ${row.required ? '*' : ' '} ${(row.label || '').slice(0, 70)}`);
  console.log(`         tenant=${row.tenant || 'global'} step=${row.step || '—'} → ${ans}`);
  if (row.options?.length) {
    console.log(`         options: ${row.options.slice(0, 5).join(' | ')}${row.options.length > 5 ? '…' : ''}`);
  }
}
