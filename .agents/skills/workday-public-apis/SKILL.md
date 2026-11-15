---
name: workday-public-apis
description: >-
  Curated public REST APIs and Model Context Protocol (MCP) servers for Workday Auto form data enrichment.
  Provides instant address and postal code resolution (Zippopotam, Open-Meteo, US Postal data) for Step 1
  address auto-fill, international phone number validation and E.164 formatting (Numverify, Google libphonenumber),
  and company/job classification interfaces. Activate when validating candidate contact data, resolving zipcode-to-city
  mappings, or configuring agent MCP tools.
---

# Workday Public APIs & MCP Tool Integration

This skill documents vetted, free, public REST APIs and Model Context Protocol (MCP) tool servers from the `public-apis` catalog that enhance Workday Auto's form filling accuracy and candidate data hydration.

---

## 1. Candidate Contact & Address Validation APIs

Workday forms strictly validate postal codes against cities and states in Step 1 ("My Information"). A mismatched city/zipcode causes Workday to show *"The Postal Code entered is invalid for the selected State/Province"*.

### A. Free Postal Code & City Lookup (Zippopotam.us)
- **Endpoint**: `https://api.zippopotam.us/{country}/{postalcode}` (e.g. `https://api.zippopotam.us/us/90210`)
- **Auth**: None required (100% Free & Open)
- **Use Case**: Automatically resolves City and State from candidate postal codes before filling Workday Step 1, preventing form validation rejection.
- **Example Response**:
  ```json
  {
    "post code": "90210",
    "country": "United States",
    "places": [
      { "place name": "Beverly Hills", "state": "California", "state abbreviation": "CA" }
    ]
  }
  ```

### B. Global Phone Number Formatting & Validation
- **Numverify API / Libphonenumber**:
  - Validates international phone numbers, resolves Country Phone Code (e.g. `+1` for US, `+44` for UK), and formats numbers into standard E.164.
  - Workday Step 1 requires both the Country Code dropdown and the Phone Number input to match.

---

## 2. Company & Job Title Normalization APIs

When ingesting job URLs from diverse Workday tenants:
- **Company Facts & ATS Lookup**: Normalizes company name, domain, and career portal structures.
- **Job Role Normalization**: Maps complex recruiter titles (e.g. *"Sr. Full-Stack Cloud Eng II (Remote - US)"*) to standard taxonomy (e.g. *"Software Engineer"*) for candidate resume alignment and QA retrieval.

---

## 3. Curated MCP AI Tool Servers

From the `public-apis` Model Context Protocol (MCP) index:

| MCP Server | Capability & Protocol | Workday Auto Use Case |
|---|---|---|
| **`IPstack MCP`** | Geolocation & Timezone (`stdio`, `HTTP`) | Matches candidate timezone with Workday server local time |
| **`ContextFetch MCP`** | Clean Markdown web scraping (`stdio`, `HTTP`) | Scrapes raw job descriptions for keyword scoring |
| **`InjectScan MCP`** | Deterministic prompt injection scoring | Audits scraped external job descriptions for prompt attacks |
| **`GitHub MCP`** | Repos, PRs, and issue tracking | Streamlines dev operations and bug logging |

---

## 4. Workday Step 1 Auto-Fill Helper Utility

```javascript
// backend/lib/addressEnrichment.mjs
export async function verifyAndEnrichAddress(postalCode, country = 'us') {
  try {
    const res = await fetch(`https://api.zippopotam.us/${country}/${postalCode}`);
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    return {
      city: place['place name'],
      state: place['state'],
      stateAbbr: place['state abbreviation'],
      country: data['country'],
    };
  } catch (e) {
    return null;
  }
}
```
