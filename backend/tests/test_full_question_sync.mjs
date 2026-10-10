import { loadLocalEnvOnce, getScannedJob, saveScannedJob, loadJobFormSchema } from '../lib/supabaseClient.mjs';
import { preResolveClientAnswersDetailed } from '../lib/jobFormCache.mjs';
import { loadProfile } from '../lib/planner.mjs';

loadLocalEnvOnce();

async function run() {
  console.log('🔄 Re-syncing Cambium Learning scanned_jobs with full form questions...');
  const jobUrl = 'https://cambiumlearning.wd1.myworkdayjobs.com/camb/job/Remote/Data-Analyst-I_REQ-4633';
  const schema = await loadJobFormSchema(jobUrl);
  if (!schema?.fields_schema?.length) {
    console.error('No schema found!');
    process.exit(1);
  }

  console.log(`Found ${schema.fields_schema.length} fields in job_form_schemas!`);

  function inferQuestionTypeAndOptions(label = '', value = '', meta = {}) {
    const norm = String(label || '').toLowerCase();
    const valStr = String(value || '').trim();
    let fieldType = meta.fieldType || meta.field_type || meta.type || '';
    let options = Array.isArray(meta.options) && meta.options.length ? [...meta.options] : [];

    if (!fieldType || fieldType === 'review_question' || fieldType === 'unknown' || fieldType === 'wizard_question') {
      if (/^(yes|no)$/i.test(valStr) || /\b(yes\s*\/\s*no|authorized|sponsorship|require|consent|agree|over\s*18|felony)\b/i.test(norm)) {
        fieldType = 'radio';
        if (!options.length) options = ['Yes', 'No'];
      } else if (/\b(date|dob|birth|start\s*date|graduation)\b/i.test(norm) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(valStr)) {
        fieldType = 'date';
      } else if (/\b(phone|mobile|cell)\b/i.test(norm)) {
        fieldType = 'phone';
      } else if (/\b(describe|explain|why|tell\s*us|summary|cover\s*letter|comments?|bio)\b/i.test(norm) || valStr.length > 120) {
        fieldType = 'textarea';
      } else if (/\b(country|state|province|gender|ethnicity|race|veteran|disability|degree|level\s*of\s*education|hear\s*about|device\s*type)\b/i.test(norm)) {
        fieldType = 'dropdown';
        if (valStr && !options.includes(valStr)) options.push(valStr);
      } else {
        fieldType = 'text';
      }
    }
    return { fieldType, options };
  }

  const enrichedQuestions = schema.fields_schema.map(f => {
    const { fieldType, options } = inferQuestionTypeAndOptions(f.label, '', f);
    return {
      label: f.label,
      question: f.label,
      question_normalized: f.label.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim(),
      value: '',
      field_type: fieldType,
      type: fieldType,
      options,
      required: Boolean(f.required ?? true),
      is_required: Boolean(f.required ?? true),
      important: true,
      step: f.step || 'Application',
    };
  });

  console.log(`Enriched ${enrichedQuestions.length} questions across steps:`, [...new Set(enrichedQuestions.map(q => q.step))]);

  const existingScanned = await getScannedJob(jobUrl);
  await saveScannedJob({
    applywizzId: existingScanned?.applywizz_id || 'AWL-1568',
    jobUrl,
    jobId: 'REQ-4633',
    company: existingScanned?.company || 'Cambium Learning Group',
    roleTitle: existingScanned?.role_title || 'Data Analyst I',
    scrapedQuestions: enrichedQuestions,
    screenshotPath: existingScanned?.screenshot_path || null,
    clientCount: existingScanned?.client_count || 14,
    scanStatus: 'completed',
  });

  console.log('✅ Updated scanned_jobs with all questions!');

  const profile1 = await loadProfile(null, { applywizzId: 'AWL-4220' });
  const detailed1 = await preResolveClientAnswersDetailed({
    jobUrl,
    schema: { id: existingScanned.id, fields_schema: enrichedQuestions, company: 'Cambium Learning Group' },
    profile: profile1,
  });

  console.log(`AWL-4220 Resolved: ${detailed1.structuredAnswers.filter(a => a.is_answered).length} / ${enrichedQuestions.length}`);
  console.log('Sample resolved answers:');
  for (const a of detailed1.structuredAnswers.slice(0, 6)) {
    console.log(`  - [${a.step || 'N/A'}] ${a.question} (${a.field_type}): "${a.answer}" [Tier ${a.tier}]`);
  }
}

run().catch(console.error);
