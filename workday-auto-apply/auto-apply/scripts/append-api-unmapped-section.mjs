import { readFileSync, writeFileSync, appendFileSync } from 'fs';

const report = JSON.parse(readFileSync('data/APPLYWIZZ-API-GAP-REPORT.json', 'utf8'));
const info = report.additional_information_from_api || {};

const unmappedButPresent = [
  { api_field: 'is_over_18', value: info.is_over_18, would_cover: ['Are you 18 years or older?', 'Are you age 18 or over?'] },
  { api_field: 'worked_for_company_before', value: info.worked_for_company_before, would_cover: ['Have you previously worked for this company?', 'Are you a former worker?', 'prior worker'] },
  { api_field: 'has_relatives_in_company', value: info.has_relatives_in_company, would_cover: ['Do you have any relatives currently employed?', 'relative employed'] },
  { api_field: 'university_name', value: info.university_name, would_cover: ['School or University (today often hardcoded Other)'] },
  { api_field: 'can_perform_essential_functions', value: info.can_perform_essential_functions, would_cover: ['Can you perform the essential functions of the job?'] },
  { api_field: 'can_work_3_days_in_office', value: info.can_work_3_days_in_office, would_cover: ['office / hybrid willingness'] },
  { api_field: 'authorized_without_visa', value: info.authorized_without_visa, would_cover: ['authorized without sponsorship'] },
  { api_field: 'date_of_birth', value: info.date_of_birth, would_cover: ['Date of Birth / DOB'] },
  { api_field: 'primary_phone', value: info.primary_phone, would_cover: ['Phone Number (API value currently incomplete)'] },
  { api_field: 'state_of_residence', value: info.state_of_residence, would_cover: ['State'] },
  { api_field: 'pending_investigation', value: info.pending_investigation, would_cover: ['pending inquiry / investigation'] },
  { api_field: 'referred_by_agency', value: info.referred_by_agency, would_cover: ['agency / referral'] },
  { api_field: 'discharged_for_policy_violation', value: info.discharged_for_policy_violation, would_cover: ['terminated / policy violation'] },
  { api_field: 'failed_or_refused_drug_test', value: info.failed_or_refused_drug_test, would_cover: ['failed drug test'] },
  { api_field: 'work_preferences', value: info.work_preferences, would_cover: ['work preferences / schedule style'] },
];

report.api_fields_present_but_not_fully_mapped = unmappedButPresent;
writeFileSync('data/APPLYWIZZ-API-GAP-REPORT.json', JSON.stringify(report, null, 2));

let extra = '\n## Important — API fields that EXIST but are not fully mapped yet\n\n';
extra += 'These are **not missing from the API**. Mapping them in the bot would close some gaps without a new API.\n\n';
extra += '| API field | Current value | Workday questions it could answer |\n|---|---|---|\n';
for (const u of unmappedButPresent) {
  extra += `| \`${u.api_field}\` | ${JSON.stringify(u.value)} | ${u.would_cover.join('; ').replace(/\|/g, '/')} |\n`;
}
extra += '\n## Truly missing from Apply Wizz API (need another API / answer bank)\n\n';
extra += 'Largest gap bucket: **tenant-specific application questions** (skills essays, company-specific former-employee, weekend/OT, travel, non-compete, GSA/HHS exclusion lists, physician license, career returner, etc.). These cannot be answered from the current Apply Wizz client payload alone.\n';

appendFileSync('data/APPLYWIZZ-API-GAP-REPORT.md', extra);
console.log('Appended unmapped-but-present section');
