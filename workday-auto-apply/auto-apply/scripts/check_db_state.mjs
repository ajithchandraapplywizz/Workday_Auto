import { loadJobFormSchema, getResolvedAnswers } from '../lib/supabaseClient.mjs';

async function check() {
  const jobUrl = 'https://centricsoftware.wd501.myworkdayjobs.com/Centric/job/Campbell-CA/Senior-Data-Scientist---Consultant_JR386';
  console.log('Querying schema for:', jobUrl);

  const schema = await loadJobFormSchema(jobUrl);
  if (schema) {
    console.log('\n✅ Scanned Job Found in Supabase!');
    console.log('Company:', schema.company);
    console.log('Role:', schema.role_title);
    console.log('Steps Scanned:', schema.step_names);
    console.log('Total Fields Scanned:', schema.fields_schema?.length);
    console.log('\nFields Breakdown by Step:');
    const byStep = {};
    for (const f of (schema.fields_schema || [])) {
      const s = f.step || 'Unknown';
      byStep[s] = (byStep[s] || 0) + 1;
    }
    console.table(byStep);

    console.log('\nSample Scraped Questions & Controls:');
    (schema.fields_schema || []).slice(0, 25).forEach((f, i) => {
      console.log(`  ${String(i+1).padStart(2)}. [${f.step || '?'}] ${f.label} (${f.field_type || f.type}) required=${Boolean(f.is_required || f.required)}`);
    });
  } else {
    console.log('No schema found yet.');
  }

  console.log('\nChecking Resolved Answers for Candidate AWL-1568...');
  const ra = await getResolvedAnswers('AWL-1568', jobUrl);
  if (ra) {
    console.log('Status:', ra.status);
    console.log('Total Resolved Questions:', ra.resolved_answers_json?.length);
    console.log('Sample Resolved Answers:');
    (ra.resolved_answers_json || []).slice(0, 15).forEach((a, i) => {
      console.log(`  ${i+1}. "${a.question_normalized}" → "${a.answer}" [${a.tier || 'tier?'}]`);
    });
  }
}

check().catch(console.error);
