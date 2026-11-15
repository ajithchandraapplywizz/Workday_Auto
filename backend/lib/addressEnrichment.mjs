/**
 * addressEnrichment.mjs
 * 
 * Public APIs Integration for Workday Auto.
 * Uses free public REST APIs (Zippopotam.us, Open-Meteo) to resolve
 * and validate City, State, and Postal Code mappings for Step 1
 * ("My Information") form filling, preventing Workday validation rejections.
 */

/**
 * Verify and enrich candidate postal code with exact City and State.
 * 
 * @param {string} postalCode - Candidate postal code (e.g. "90210" or "07030")
 * @param {string} country - Two-letter country code (defaults to "us")
 * @returns {Promise<{ city: string, state: string, stateAbbr: string, country: string }|null>}
 */
export async function verifyAndEnrichAddress(postalCode, country = 'us') {
  if (!postalCode) return null;
  const cleanZip = String(postalCode).trim().split('-')[0].padStart(5, '0');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`https://api.zippopotam.us/${encodeURIComponent(country)}/${encodeURIComponent(cleanZip)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return null;

    return {
      city: place['place name'] || '',
      state: place['state'] || '',
      stateAbbr: place['state abbreviation'] || '',
      country: data['country'] || 'United States',
    };
  } catch (_err) {
    return null;
  }
}
