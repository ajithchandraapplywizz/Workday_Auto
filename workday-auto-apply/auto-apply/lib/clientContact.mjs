/**
 * clientContact.mjs — US Workday contact fields from Apply Wizz + persisted phone.
 */

import fs from 'fs/promises';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { isApiOnlyAnswerMode } from './apiOnlyProfile.mjs';

export const US_COUNTRY_PHONE_CODE = 'United States of America (+1)';
export const US_COUNTRY_NAME = 'United States of America';
export const IN_COUNTRY_PHONE_CODE = 'India (+91)';
export const IN_COUNTRY_NAME = 'India';

/**
 * Workday country / territory phone code label from a country name.
 * @param {string} country
 * @returns {string}
 */
export const COUNTRY_PHONE_MAP = {
  'united states': 'United States of America (+1)',
  'united states of america': 'United States of America (+1)',
  'usa': 'United States of America (+1)',
  'india': 'India (+91)',
  'canada': 'Canada (+1)',
  'united kingdom': 'United Kingdom (+44)',
  'great britain': 'United Kingdom (+44)',
  'uk': 'United Kingdom (+44)',
  'australia': 'Australia (+61)',
  'germany': 'Germany (+49)',
  'france': 'France (+33)',
  'mexico': 'Mexico (+52)',
  'brazil': 'Brazil (+55)',
  'spain': 'Spain (+34)',
  'italy': 'Italy (+39)',
  'netherlands': 'Netherlands (+31)',
  'singapore': 'Singapore (+65)',
  'ireland': 'Ireland (+353)',
  'philippines': 'Philippines (+63)',
  'pakistan': 'Pakistan (+92)',
  'china': 'China (+86)',
  'japan': 'Japan (+81)',
  'nigeria': 'Nigeria (+234)',
  'south africa': 'South Africa (+27)',
};

export function workdayPhoneCodeForCountry(country = '') {
  const c = String(country || '').toLowerCase().trim();
  if (!c) return '';
  if (/india/.test(c)) return IN_COUNTRY_PHONE_CODE;
  if (/united states|usa|u\.s\.|america/.test(c)) return US_COUNTRY_PHONE_CODE;
  if (/canada/.test(c)) return 'Canada (+1)';
  if (/united kingdom|britain|uk\b/.test(c)) return 'United Kingdom (+44)';
  if (/australia/.test(c)) return 'Australia (+61)';
  if (/germany/.test(c)) return 'Germany (+49)';
  for (const [k, v] of Object.entries(COUNTRY_PHONE_MAP)) {
    if (c.includes(k) || k.includes(c)) return v;
  }
  return '';
}

/**
 * @param {string} raw
 * @param {string} countryHint country name or phone code string
 * @returns {string} digits for Workday tel input
 */
export function normalizePhoneForCountry(raw = '', countryHint = '') {
  const hint = `${countryHint} ${raw}`.toLowerCase();
  let d = digitsOnly(raw);
  if (/india|\+91/.test(hint)) {
    if (d.length >= 12 && d.startsWith('91')) d = d.slice(-10);
    if (d.length > 10) d = d.slice(-10);
    return d.length === 10 ? d : d;
  }
  return formatPlainUsPhone(raw);
}

export function isIndiaCountryProfile(profile = {}) {
  const blob = `${profile?.personal?.country || ''} ${profile?.personal?.country_phone_code || ''}`.toLowerCase();
  return /india|\+91/.test(blob);
}

/**
 * Merge API overlay without wiping YAML values with undefined/empty.
 * @param {object} base
 * @param {object} overlay
 * @returns {object}
 */
export function mergeNonEmpty(base = {}, overlay = {}) {
  const out = { ...base };
  for (const [key, val] of Object.entries(overlay)) {
    if (val === undefined || val === null) continue;
    if (typeof val === 'string' && val.trim() === '') continue;
    out[key] = val;
  }
  return out;
}

const CONTACT_KEYS = [
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'country',
  'country_phone_code',
  'phone',
  'email',
];

/**
 * @param {string} raw
 * @returns {string} digits only
 */
export function digitsOnly(raw = '') {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * US mobile for Workday tel inputs — digits only, 10 NANP digits when possible.
 * @param {string} raw
 * @returns {string}
 */
export function formatPlainUsPhone(raw = '') {
  let d = digitsOnly(raw);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length >= 10) return d.slice(-10);
  return d;
}

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico',
};

export const IN_STATES = new Set([
  'telangana', 'andhra pradesh', 'karnataka', 'tamil nadu', 'maharashtra',
  'delhi', 'uttar pradesh', 'up', 'gujarat', 'kerala', 'punjab', 'haryana',
  'west bengal', 'wb', 'rajasthan', 'madhya pradesh', 'mp', 'bihar', 'odisha',
  'orissa', 'assam', 'jharkhand', 'chhattisgarh', 'uttarakhand',
  'himachal pradesh', 'goa', 'jammu and kashmir', 'chandigarh', 'puducherry',
  'hyderabad', 'bengaluru', 'bangalore', 'mumbai', 'chennai', 'kolkata', 'pune',
]);

export const CA_PROVINCES = {
  ON: 'Ontario', BC: 'British Columbia', AB: 'Alberta', QC: 'Quebec',
  MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island',
};

/**
 * Given a state or region, determine the country and matching country phone code.
 */
export function resolveLocationAndCountry(stateOrLoc = '', city = '', contextBlob = '') {
  const s = String(stateOrLoc || '').trim();
  const sUpper = s.toUpperCase();
  const sLower = s.toLowerCase();
  const cLower = String(city || '').toLowerCase().trim();
  const blobLower = String(contextBlob || '').toLowerCase();

  // 1. Check US States by 2-letter abbreviation
  if (US_STATES[sUpper]) {
    return {
      state: US_STATES[sUpper],
      stateCode: sUpper,
      city: city || '',
      country: US_COUNTRY_NAME,
      country_phone_code: US_COUNTRY_PHONE_CODE,
    };
  }

  // 1b. Check US States by full name
  for (const [code, name] of Object.entries(US_STATES)) {
    if (sLower === name.toLowerCase() || sLower.includes(name.toLowerCase())) {
      return {
        state: name,
        stateCode: code,
        city: city || '',
        country: US_COUNTRY_NAME,
        country_phone_code: US_COUNTRY_PHONE_CODE,
      };
    }
  }

  // 2. Check Indian States / Metros (e.g. Telangana, Karnataka, Hyderabad, etc.)
  if (IN_STATES.has(sLower) || IN_STATES.has(cLower)) {
    const capitalizedState = s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
    return {
      state: capitalizedState,
      stateCode: sUpper,
      city: city || '',
      country: IN_COUNTRY_NAME,
      country_phone_code: IN_COUNTRY_PHONE_CODE,
    };
  }

  // 3. Check Canadian Provinces
  if (CA_PROVINCES[sUpper]) {
    return {
      state: CA_PROVINCES[sUpper],
      stateCode: sUpper,
      city: city || '',
      country: 'Canada',
      country_phone_code: 'Canada (+1)',
    };
  }
  for (const [code, name] of Object.entries(CA_PROVINCES)) {
    if (sLower === name.toLowerCase()) {
      return {
        state: name,
        stateCode: code,
        city: city || '',
        country: 'Canada',
        country_phone_code: 'Canada (+1)',
      };
    }
  }

  // 4. Check context blob hints
  if (/united states|usa|\bu\.s\.\b|\bamerica\b/i.test(blobLower)) {
    return {
      state: s,
      stateCode: sUpper,
      city: city || '',
      country: US_COUNTRY_NAME,
      country_phone_code: US_COUNTRY_PHONE_CODE,
    };
  }
  if (/india|\b\+91\b/i.test(blobLower)) {
    return {
      state: s,
      stateCode: sUpper,
      city: city || '',
      country: IN_COUNTRY_NAME,
      country_phone_code: IN_COUNTRY_PHONE_CODE,
    };
  }

  return {
    state: s,
    stateCode: sUpper,
    city: city || '',
    country: US_COUNTRY_NAME,
    country_phone_code: US_COUNTRY_PHONE_CODE,
  };
}

/**
 * AI-powered fallback when location is ambiguous.
 */
export async function analyzeLocationWithAi(locationStr = '', contextText = '') {
  try {
    const { openRouterChat, isOpenRouterEnabled } = await import('./openRouterLlm.mjs');
    if (!isOpenRouterEnabled() || !locationStr.trim()) return null;
    const res = await openRouterChat({
      messages: [
        {
          role: 'system',
          content: 'You are an address analyzer. Analyze the given location and return JSON with keys: city, state, country, country_phone_code.',
        },
        {
          role: 'user',
          content: `Location: "${locationStr}". Context: "${String(contextText || '').slice(0, 200)}"`,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
    });
    const content = res?.choices?.[0]?.message?.content?.trim() || '';
    const clean = content.replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(clean);
    if (parsed && parsed.country) {
      if (/united states|usa/i.test(parsed.country)) {
        parsed.country = US_COUNTRY_NAME;
        parsed.country_phone_code = US_COUNTRY_PHONE_CODE;
      } else if (/india/i.test(parsed.country)) {
        parsed.country = IN_COUNTRY_NAME;
        parsed.country_phone_code = IN_COUNTRY_PHONE_CODE;
      }
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * Pull phone, country, and address hints from resume plain text (no invention).
 * Analyzes City, State (e.g. "Boston, MA", "St. Louis, MO", "Hyderabad, Telangana")
 * and resolves matching Country and Country Phone Code.
 * @param {string} text
 * @returns {{ phone?: string, country?: string, country_phone_code?: string, address_line1?: string, city?: string, state?: string, postal_code?: string }}
 */
export function extractContactFromResumeText(text = '') {
  const blob = String(text || '');
  if (!blob.trim()) return {};
  const out = {};

  const labeledPhone = blob.match(
    /(?:phone|mobile|cell|tel(?:ephone)?)\s*[:\-]?\s*([+\d\s().-]{10,24})/i,
  );
  const barePhone = blob.match(
    /\b(?:\+1[\s.-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}\b/,
  );
  const phoneRaw = labeledPhone?.[1] || barePhone?.[0] || '';
  const plain = formatPlainUsPhone(phoneRaw);
  if (plain.length === 10 && isUsTenDigitPhone(plain)) {
    out.phone = plain;
  }

  const street = blob.match(
    /\b(\d+\s+[A-Za-z0-9][\w\s.'#-]{2,60}(?:\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct)\.?))(?:\s*,|\s+)/i,
  );
  if (street?.[1]) out.address_line1 = street[1].replace(/\s+/g, ' ').trim().slice(0, 120);

  // 1. Match City, State Zip: e.g. "Austin, TX 78701" or "St. Louis, MO 63108"
  const cityStateZip = blob.match(/([A-Za-z][A-Za-z .'-]{1,40}),[ \t]*([A-Z]{2})[ \t]+(\d{5})(?:-\d{4})?/);
  if (cityStateZip) {
    const resolved = resolveLocationAndCountry(cityStateZip[2], cityStateZip[1].trim(), blob);
    out.city = resolved.city;
    out.state = cityStateZip[2];
    out.state_full = resolved.state;
    out.country = resolved.country;
    out.country_phone_code = resolved.country_phone_code;
    out.postal_code = cityStateZip[3];
  } else {
    // 2. Match City, 2-letter State: e.g. "Boston, MA" or "St. Louis, MO" or "Toronto, ON"
    const cityState2 = blob.match(/\b([A-Za-z][A-Za-z .'-]{1,40}),[ \t]*([A-Z]{2})\b/);
    if (cityState2 && (US_STATES[cityState2[2]] || CA_PROVINCES[cityState2[2]])) {
      const resolved = resolveLocationAndCountry(cityState2[2], cityState2[1].trim(), blob);
      out.city = resolved.city;
      out.state = cityState2[2];
      out.state_full = resolved.state;
      out.country = resolved.country;
      out.country_phone_code = resolved.country_phone_code;
    } else {
      // 3. Match City, Full State: e.g. "Hyderabad, Telangana" or "St. Louis, Missouri"
      const cityStateFull = blob.match(/\b([A-Za-z][A-Za-z .'-]{1,40}),[ \t]*([A-Za-z][A-Za-z ]{1,25})\b/);
      if (cityStateFull) {
        const resolved = resolveLocationAndCountry(cityStateFull[2].trim(), cityStateFull[1].trim(), blob);
        out.city = resolved.city;
        out.state = resolved.state;
        out.state_full = resolved.state;
        out.country = resolved.country;
        out.country_phone_code = resolved.country_phone_code;
      }
    }
  }

  // Ensure Country & Country Phone Code are filled if still unset
  if (!out.country) {
    if (/\bunited states of america\b|\bunited states\b|\bUSA\b|\bU\.S\.A\b|\bU\.S\.\b/i.test(blob)) {
      out.country = US_COUNTRY_NAME;
      out.country_phone_code = US_COUNTRY_PHONE_CODE;
    } else if (/\bindia\b|\b\+91\b/i.test(blob)) {
      out.country = IN_COUNTRY_NAME;
      out.country_phone_code = IN_COUNTRY_PHONE_CODE;
    } else {
      out.country = US_COUNTRY_NAME;
      out.country_phone_code = US_COUNTRY_PHONE_CODE;
    }
  } else if (!out.country_phone_code) {
    out.country_phone_code = workdayPhoneCodeForCountry(out.country) || US_COUNTRY_PHONE_CODE;
  }

  return out;
}

/**
 * Persist client contact/address information to Supabase permanently for future use.
 * @param {object} profile
 */
export async function persistClientAddressToSupabase(profile = {}) {
  const applywizzId = profile?._applyWizzId;
  if (!applywizzId) return false;

  try {
    const { isSupabaseConfigured, upsertSupabaseAnswers, upsertSupabaseClient } = await import('./supabaseClient.mjs');
    if (!isSupabaseConfigured()) return false;

    const p = profile.personal || {};
    const entries = [];
    if (p.country) entries.push({ questionNormalized: 'country', question: 'Country', answer: p.country });
    if (p.country_phone_code) entries.push({ questionNormalized: 'country phone code', question: 'Country / Territory Phone Code', answer: p.country_phone_code });
    if (p.state) entries.push({ questionNormalized: 'state', question: 'State', answer: p.state });
    if (p.city) entries.push({ questionNormalized: 'city', question: 'City', answer: p.city });
    if (p.postal_code) entries.push({ questionNormalized: 'postal code', question: 'Postal Code', answer: p.postal_code });
    if (p.address_line1) entries.push({ questionNormalized: 'address line 1', question: 'Address Line 1', answer: p.address_line1 });
    if (p.phone) entries.push({ questionNormalized: 'phone number', question: 'Phone Number', answer: p.phone });

    if (entries.length > 0) {
      await upsertSupabaseAnswers(applywizzId, entries).catch(() => {});
      console.log(`    💾 Saved ${entries.length} address/contact field(s) to Supabase for ${applywizzId}`);
    }

    const loc = [p.city, p.state, p.country].filter(Boolean).join(', ');
    if (loc) {
      await upsertSupabaseClient({
        applywizzId,
        latestJobLocation: loc,
        mobileNumber: p.phone || '',
      }).catch(() => {});
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Merge resume contact facts onto profile.personal (does not overwrite non-empty API values).
 * @param {object} profile
 */
export function mergeResumeContactIntoProfile(profile = {}) {
  const text = profile._resumeText || '';
  if (!text.trim()) return profile;
  profile.personal = profile.personal || {};
  const fromResume = extractContactFromResumeText(text);
  profile.personal = mergeNonEmpty(profile.personal, fromResume);
  if (fromResume.phone) {
    profile.personal.phone = formatPlainUsPhone(fromResume.phone);
  }
  // Guarantee both Country and Country Phone Code are identical/matching
  if (profile.personal.country && !profile.personal.country_phone_code) {
    profile.personal.country_phone_code = workdayPhoneCodeForCountry(profile.personal.country);
  }
  if (profile._applyWizzId) {
    persistClientAddressToSupabase(profile).catch(() => {});
  }
  return profile;
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isUsTenDigitPhone(raw = '') {
  const d = digitsOnly(raw);
  if (d.length === 11 && d.startsWith('1')) return /^[2-9]\d{9}$/.test(d.slice(1));
  return d.length === 10 && /^[2-9]\d{9}$/.test(d);
}

/**
 * Stable pseudo-random US mobile (10 digits, valid NANP area code).
 * @param {string} [seed]
 * @returns {string}
 */
export function generateUsPhoneNumber(seed = '') {
  const base = digitsOnly(seed) || String(Date.now());
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  const area = 200 + (h % 799);
  const exchange = 200 + ((h >>> 8) % 799);
  const line = String(1000 + ((h >>> 16) % 9000)).padStart(4, '0');
  return `${area}${exchange}${line}`.slice(0, 10);
}

/**
 * Merge Apply Wizz contact/address onto profile (API wins over local YAML for those keys).
 * @param {object} profile
 * @param {object} [apiPersonal]
 */
export function mergeApplyWizzContact(profile = {}, apiPersonal = {}) {
  if (!apiPersonal || typeof apiPersonal !== 'object') return profile;
  profile.personal = profile.personal || {};
  profile.personal = { ...profile.personal, ...apiPersonal };
  for (const key of CONTACT_KEYS) {
    const v = apiPersonal[key];
    if (v != null && String(v).trim() !== '') {
      profile.personal[key] = String(v).trim();
    }
  }
  const qa = profile._applyWizzQa || {};
  if (qa.state && !profile.personal.state) profile.personal.state = qa.state;
  if (qa['address line 1'] && !profile.personal.address_line1) {
    profile.personal.address_line1 = qa['address line 1'];
  }
  if (qa.city && !profile.personal.city) profile.personal.city = qa.city;
  if (qa['postal code'] && !profile.personal.postal_code) {
    profile.personal.postal_code = qa['postal code'];
  }
  return profile;
}

/**
 * @param {object} partial
 * @param {string} [profilePath]
 */
export async function savePersonalFieldsToYaml(partial = {}, profilePath) {
  if (isApiOnlyAnswerMode()) return;
  const pPath = profilePath || resolve(process.cwd(), 'config', 'profile.yml');
  try {
    let doc = {};
    try {
      doc = yaml.load(await fs.readFile(pPath, 'utf-8')) || {};
    } catch {
      return;
    }
    doc.personal = { ...(doc.personal || {}), ...partial };
    await fs.writeFile(pPath, yaml.dump(doc, { indent: 2, lineWidth: -1 }), 'utf-8');
    console.log(`    💾 Saved personal contact fields to config/profile.yml`);
  } catch (err) {
    console.log(`    ⚠️  Could not save personal fields: ${err.message}`);
  }
}

/**
 * US phone code + number for Workday My Information; persist generated numbers.
 * @param {object} profile
 * @returns {Promise<object>} profile
 */
/**
 * Align phone + country + country phone code with Apply Wizz API / resume (no forced US override).
 * @param {object} profile
 */
export async function ensureWorkdayContactFromClient(profile = {}) {
  profile.personal = profile.personal || {};
  mergeResumeContactIntoProfile(profile);
  const p = profile.personal;

  const qa = profile._applyWizzQa || {};
  if (!p.country && qa.country) p.country = qa.country;
  if (!p.state && qa.state) p.state = qa.state;
  if (!p.city && qa.city) p.city = qa.city;
  if (!p.postal_code && qa['postal code']) p.postal_code = qa['postal code'];

  const countryHint = p.country || p.country_phone_code || '';
  const fromApi = normalizePhoneForCountry(
    p.phone || qa.phone || profile._applyWizzClientContext?.additional_information?.primary_phone || '',
    countryHint,
  );
  if (fromApi && fromApi.length >= 10) {
    p.phone = fromApi;
  }

  const codeFromCountry = workdayPhoneCodeForCountry(p.country);
  if (codeFromCountry) {
    p.country_phone_code = codeFromCountry;
  } else if (!p.country_phone_code) {
    p.country_phone_code = US_COUNTRY_PHONE_CODE;
  }

  if (/united states|usa/i.test(String(p.country || ''))) {
    p.country = US_COUNTRY_NAME;
  } else if (/^india$/i.test(String(p.country || '').trim())) {
    p.country = IN_COUNTRY_NAME;
  }

  let phone = normalizePhoneForCountry(p.phone || '', `${p.country} ${p.country_phone_code}`);
  const usJob = /united states|usa|\+\s*1\b/i.test(`${p.country_phone_code} ${p.country}`);
  if (!phone || phone.length < 10) {
    if (usJob && isUsTenDigitPhone(formatPlainUsPhone(phone))) {
      phone = formatPlainUsPhone(phone);
    } else if (usJob) {
      const seed = profile._applyWizzId || p.email || p.first_name || '';
      phone = generateUsPhoneNumber(seed);
      profile._generatedPhone = true;
      console.log(`  📞 Generated US phone (API/resume had none): ${phone}`);
      await savePersonalFieldsToYaml({
        phone,
        country_phone_code: p.country_phone_code,
        country: p.country,
      });
    }
  }
  if (phone) p.phone = phone;

  if (p.phone_extension == null || p.phone_extension === '') {
    p.phone_extension = '';
  }

  return profile;
}

/** @deprecated Use ensureWorkdayContactFromClient */
export async function ensureUsWorkdayContact(profile = {}) {
  return ensureWorkdayContactFromClient(profile);
}

/**
 * US 5-digit ZIP from Apply Wizz/profile, else India 6-digit fallback.
 * @param {object} profile
 * @param {(p: object) => string} indiaFallback
 * @returns {string}
 */
export function resolvePostalForWorkday(profile = {}, indiaFallback) {
  const hint = `${profile?.personal?.country_phone_code || ''} ${profile?.personal?.country || ''}`;
  const usZip = String(profile?.personal?.postal_code || '').trim();
  if (/united states|\+1/i.test(hint) && /^\d{5}(-\d{4})?$/.test(usZip)) {
    return usZip.slice(0, 5);
  }
  if (typeof indiaFallback === 'function') return indiaFallback(profile);
  return usZip || '94102';
}
