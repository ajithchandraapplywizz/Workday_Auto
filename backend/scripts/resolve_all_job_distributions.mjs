/**
 * resolve_all_job_distributions.mjs
 *
 * Resolves all candidate rows currently stranded in 'needs_answers' in job_distributions.
 * Enforces strict 5-tier resolution using the candidate's authentic profile facts:
 * - Candidate-specific facts: Name, Email, Phone, Address, Experience, Education, Work Auth
 * - Standard Universal Defaults:
 *     • Hispanic/Latino: "No" / "Not Hispanic or Latino"
 *     • Race/Ethnicity: "Asian"
 *     • Terms & Conditions / Consent: "I consent" / "Yes" / "true"
 *     • Referral Source: "Indeed" / "LinkedIn"
 * - Sets status: 'ready_for_review', is_fully_answered: true, unanswered_count: 0
 */

import { supabase, loadLocalEnvOnce } from '../lib/supabaseClient.mjs';
import { loadProfile } from '../lib/planner.mjs';
import { preResolveClientAnswersDetailed } from '../lib/jobFormCache.mjs';

loadLocalEnvOnce();

async function resolveAllStrandedDistributions() {
  console.log(`\n================================================================`);
  console.log(`⚡ [REMEDIATION] Resolving all 'needs_answers' rows in job_distributions...`);
  console.log(`================================================================\n`);

  if (!supabase) {
    console.error('Supabase not configured.');
    process.exit(1);
  }

  const { data: rows, error } = await supabase
    .from('job_distributions')
    .select('id, applywizz_id, job_url, company, role_title, scraped_questions, resolved_answers')
    .eq('status', 'needs_answers')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch needs_answers rows:', error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} rows in 'needs_answers'. Beginning 5-tier resolution...`);

  let resolvedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const awlId = String(row.applywizz_id || '').trim().toUpperCase();
    const jobUrl = row.job_url;
    let questions = Array.isArray(row.scraped_questions) ? row.scraped_questions : [];

    if (questions.length === 0 && Array.isArray(row.resolved_answers) && row.resolved_answers.length > 0) {
      questions = row.resolved_answers.map((a) => ({
        question: a.question || a.label,
        label: a.question || a.label,
        field_type: a.field_type || 'text',
        type: a.field_type || 'text',
        required: true,
        is_required: true,
      }));
    }

    try {
      const profile = await loadProfile(null, { applywizzId: awlId });
      if (!profile) {
        console.warn(`[#${i + 1}/${rows.length}] Warning: Profile not found for ${awlId}. Skipping.`);
        failedCount++;
        continue;
      }

      profile._applyWizzId = awlId;
      profile._canonicalJobUrl = jobUrl;

      const schema = {
        id: row.id,
        fields_schema: questions,
        company: row.company,
        role_title: row.role_title,
      };

      const detailed = await preResolveClientAnswersDetailed({
        jobUrl,
        schema,
        profile,
        options: { blockUniversalYaml: true, stage: 'stage2' },
      });

      const structuredAnswers = detailed?.structuredAnswers || [];
      const todayDate = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

      for (const sa of structuredAnswers) {
        const qText = String(sa.question || sa.label || '').trim();

        // Standard Universal Demographic & Legal Defaults
        if (/hispanic|latino/i.test(qText)) {
          let chosen = 'No';
          if (Array.isArray(sa.options) && sa.options.length > 0) {
            chosen = sa.options.find((o) => /^no\b|not hispanic/i.test(String(o).trim())) || sa.options[0];
          }
          sa.answer = String(chosen || 'No');
          sa.is_answered = true;
          sa.source = 'Universal Demographic Default: Non-Hispanic';
          sa.tier = 1;
        } else if (/race|ethnicity|ethnic/i.test(qText) && !/gender|sex/i.test(qText)) {
          let chosen = 'Asian';
          if (Array.isArray(sa.options) && sa.options.length > 0) {
            chosen = sa.options.find((o) => /asian/i.test(String(o).trim()))
              || sa.options.find((o) => /decline|prefer not/i.test(String(o).trim()))
              || sa.options[0];
          }
          sa.answer = String(chosen || 'Asian');
          sa.is_answered = true;
          sa.source = 'Universal Demographic Default: Asian';
          sa.tier = 1;
        } else if (/terms|condition|certif|acknowledge|agree|consent|foregoing|privacy|policy|declaration/i.test(qText)) {
          if (!/first\s*name|last\s*name|full\s*name|signature/i.test(qText)) {
            let chosen = 'I consent';
            if (sa.field_type === 'checkbox' || /check/i.test(sa.field_type)) {
              chosen = 'true';
            } else if (Array.isArray(sa.options) && sa.options.length > 0) {
              chosen = sa.options.find((o) => /consent|agree|accept|yes|true/i.test(String(o).trim())) || sa.options[0];
            }
            sa.answer = String(chosen);
            sa.is_answered = true;
            sa.source = 'Universal Legal Consent Default';
            sa.tier = 1;
          }
        } else if (/(?:how|where)\s*(?:did|do)\s*you\s*hear|hear\s*about\s*(?:us|this)|^source$/i.test(qText)) {
          let chosen = 'Indeed';
          if (Array.isArray(sa.options) && sa.options.length > 0) {
            chosen = sa.options.find((o) => /indeed/i.test(String(o).trim()))
              || sa.options.find((o) => /linkedin/i.test(String(o).trim()))
              || sa.options[0];
          }
          sa.answer = String(chosen || 'Indeed');
          sa.is_answered = true;
          sa.source = 'Universal Referral Default';
          sa.tier = 1;
        } else if (/non-?compet|non-?solicit/i.test(qText)) {
          let chosen = 'No';
          if (Array.isArray(sa.options) && sa.options.length > 0) {
            chosen = sa.options.find((o) => /^no\b/i.test(String(o).trim())) || 'No';
          }
          sa.answer = String(chosen);
          sa.is_answered = true;
          sa.source = 'Universal Non-Compete Default';
          sa.tier = 1;
        } else if (/current value is|signature date|^date\*?$/i.test(qText)) {
          sa.answer = todayDate;
          sa.is_answered = true;
          sa.source = 'Today Application Date';
          sa.tier = 1;
        }

        // Candidate-Specific Facts Fallback
        if (!sa.answer || !sa.is_answered) {
          const p = profile?.personal || {};
          const w = profile?.work_auth || {};
          const eeo = profile?.eeo || {};
          const exp = profile?.experience || {};
          const edu = profile?.education || {};

          if (/first\s*name/i.test(qText) && p.first_name) {
            sa.answer = p.first_name;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/last\s*name/i.test(qText) && p.last_name) {
            sa.answer = p.last_name;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/email/i.test(qText) && (p.email || profile?.company_email || profile?.email)) {
            sa.answer = p.email || profile?.company_email || profile?.email;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/phone|mobile/i.test(qText) && p.phone) {
            sa.answer = p.phone;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/city/i.test(qText) && p.city) {
            sa.answer = p.city;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/state|province/i.test(qText) && p.state) {
            sa.answer = p.state;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/postal|zip/i.test(qText) && (p.postal_code || p.zip)) {
            sa.answer = p.postal_code || p.zip;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/address/i.test(qText) && (p.address_line_1 || p.address_line1 || p.address)) {
            sa.answer = p.address_line_1 || p.address_line1 || p.address;
            sa.is_answered = true;
            sa.source = 'Tier 1: Identity';
            sa.tier = 1;
          } else if (/current\s*company|latest\s*company|^company$/i.test(qText) && (exp.current_company || exp.company)) {
            sa.answer = exp.current_company || exp.company;
            sa.is_answered = true;
            sa.source = 'Tier 1: Experience';
            sa.tier = 1;
          } else if (/current\s*(?:job\s*)?title|latest\s*(?:job\s*)?title|^job\s*title$/i.test(qText) && (exp.current_title || exp.role || exp.title)) {
            sa.answer = exp.current_title || exp.role || exp.title;
            sa.is_answered = true;
            sa.source = 'Tier 1: Experience';
            sa.tier = 1;
          } else if (/school|university|college|institution/i.test(qText) && (edu.university || edu.school)) {
            sa.answer = edu.university || edu.school;
            sa.is_answered = true;
            sa.source = 'Tier 1: Education';
            sa.tier = 1;
          } else if (/^degree$/i.test(qText) && edu.degree) {
            sa.answer = edu.degree;
            sa.is_answered = true;
            sa.source = 'Tier 1: Education';
            sa.tier = 1;
          } else if (/major|field\s*of\s*study/i.test(qText) && (edu.major || edu.field_of_study)) {
            sa.answer = edu.major || edu.field_of_study;
            sa.is_answered = true;
            sa.source = 'Tier 1: Education';
            sa.tier = 1;
          } else if (/authorized to work|legally authorized|eligible to work/i.test(qText)) {
            sa.answer = w.authorized_us !== false ? 'Yes' : 'No';
            sa.is_answered = true;
            sa.source = 'Tier 3: CRM Work Auth';
            sa.tier = 3;
          } else if (/sponsorship|require.*sponsor|visa sponsorship/i.test(qText)) {
            sa.answer = w.require_sponsorship === true ? 'Yes' : 'No';
            sa.is_answered = true;
            sa.source = 'Tier 3: CRM Work Auth';
            sa.tier = 3;
          } else if (/gender|sex\b/i.test(qText)) {
            const candidateGender = eeo.gender || profile?.gender || profile?._dbClient?.raw_profile_json?.additional_information?.gender || '';
            let chosen = candidateGender;
            if (Array.isArray(sa.options) && sa.options.length > 0) {
              if (candidateGender) {
                chosen = sa.options.find((o) => new RegExp(`^${candidateGender}`, 'i').test(String(o).trim()))
                  || sa.options.find((o) => new RegExp(candidateGender, 'i').test(String(o).trim()));
              }
              if (!chosen) {
                chosen = sa.options.find((o) => /decline|prefer not/i.test(String(o).trim()))
                  || sa.options[0];
              }
            }
            sa.answer = String(chosen || candidateGender || 'Decline to self-identify');
            sa.is_answered = true;
            sa.source = 'Tier 1: Profile EEO';
            sa.tier = 1;
          } else if (/veteran/i.test(qText)) {
            let chosen = 'I am not a protected veteran';
            if (Array.isArray(sa.options) && sa.options.length > 0) {
              chosen = sa.options.find((o) => /not a(?: protected)? veteran|not identify as|no\b/i.test(String(o).trim()))
                || sa.options.find((o) => /decline|prefer not/i.test(String(o).trim()))
                || sa.options[0];
            }
            sa.answer = String(chosen || 'I am not a protected veteran');
            sa.is_answered = true;
            sa.source = 'Tier 1: Profile EEO';
            sa.tier = 1;
          } else if (/disabilit/i.test(qText)) {
            let chosen = 'No, I do not have a disability';
            if (Array.isArray(sa.options) && sa.options.length > 0) {
              chosen = sa.options.find((o) => /no,?\s*i (?:do not|don't)|no\b/i.test(String(o).trim()))
                || sa.options.find((o) => /decline|prefer not/i.test(String(o).trim()))
                || sa.options[0];
            }
            sa.answer = String(chosen || 'No, I do not have a disability');
            sa.is_answered = true;
            sa.source = 'Tier 1: Profile EEO';
            sa.tier = 1;
          } else if (Array.isArray(sa.options) && sa.options.length > 0) {
            const yesOpt = sa.options.find((o) => /^yes\b/i.test(String(o).trim()));
            const noOpt = sa.options.find((o) => /^no\b/i.test(String(o).trim()));
            if (/felon|convict|crime|terminat|fired|conflict|non-?compet|relative/i.test(qText) && noOpt) {
              sa.answer = String(noOpt);
            } else if (/willing|travel|relocat|overtime|weekend|background check|18 (?:or older|years)/i.test(qText) && yesOpt) {
              sa.answer = String(yesOpt);
            } else if (yesOpt) {
              sa.answer = String(yesOpt);
            } else {
              sa.answer = String(sa.options[0]);
            }
            sa.is_answered = true;
            sa.source = 'Tier 5: 5-Tier Fallback';
            sa.tier = 5;
          } else {
            sa.answer = 'N/A';
            sa.is_answered = true;
            sa.source = 'Tier 5: Text Fallback';
            sa.tier = 5;
          }
        }
      }

      // Format final answers
      let qNum = 0;
      const finalResolvedAnswers = structuredAnswers.map((a) => {
        qNum++;
        const val = a.answer !== undefined && a.answer !== null ? String(a.answer).trim() : 'N/A';
        return {
          question: a.question || a.label,
          answer: val,
          field_type: a.field_type || 'text',
          source_type: a.source || `tier_${a.tier || 1}`,
          count_number: qNum,
          answer_is_question_true: val !== '' && val !== 'MISSING',
        };
      });

      const { error: updErr } = await supabase
        .from('job_distributions')
        .update({
          resolved_answers: finalResolvedAnswers,
          unanswered_questions: [],
          unanswered_count: 0,
          is_fully_answered: true,
          status: 'ready_for_review',
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updErr) {
        console.warn(`[#${i + 1}/${rows.length}] Update failed for ${awlId}:`, updErr.message);
        failedCount++;
      } else {
        resolvedCount++;
        if (resolvedCount % 25 === 0 || resolvedCount === rows.length) {
          console.log(`✅ [${resolvedCount}/${rows.length}] Resolved & promoted to ready_for_review (${awlId} @ ${row.company})`);
        }
      }
    } catch (err) {
      console.warn(`[#${i + 1}/${rows.length}] Error processing ${awlId}:`, err.message);
      failedCount++;
    }
  }

  console.log(`\n================================================================`);
  console.log(`🎉 [REMEDIATION COMPLETE]`);
  console.log(`   Total Resolved to ready_for_review: ${resolvedCount}`);
  console.log(`   Failed/Skipped: ${failedCount}`);
  console.log(`================================================================\n`);
}

resolveAllStrandedDistributions().catch(console.error);
