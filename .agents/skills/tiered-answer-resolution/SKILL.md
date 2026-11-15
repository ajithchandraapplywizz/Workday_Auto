---
name: tiered-answer-resolution
description: >-
  Strict 4-tier answer resolution engine and LLM prompt orchestrator for Workday job application forms.
  Enforces deterministic truth precedence (Supabase Tier 1 -> CRM Tier 2 -> Resume Tier 3 -> Live DOM + LLM Tier 4).
  Applies regex-first extraction to resolve 95%+ of fields deterministically with zero token costs and zero latency,
  reserving LLMs exclusively for unmatched live DOM edge cases. Strictly forbids hallucinated compliance answers.
  Activate when resolving form questions, tuning LLM prompts, or mapping candidate profile data.
---

# Tiered Answer Resolution & LLM Engine

This skill defines the strict 4-tier resolution hierarchy and regex-first optimization strategy used to answer Workday application questions accurately, deterministically, and with zero hallucination.

---

## The 4-Tier Resolution Hierarchy

Always resolve questions in strict top-down order. Never invert this hierarchy:

```text
┌─────────────────────────────────────────────────────────────┐
│ Tier 0: Stage 2 Pre-Resolved Answers                        │
│ (job_distributions.resolved_answers / verified QA cache)    │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: Supabase Database (Highest Canonical Authority)     │
│ (client_questions, clients, client_additional_information) │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: Apply Wizz CRM Profile API Facts                    │
│ (First/Last name, phone, address, work auth, salary)        │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 3: Parsed Resume PDF Facts                             │
│ (Skills, university degree, graduation dates, job history)  │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 4: Live DOM Prompt Options + LLM Analysis              │
│ (OpenRouter / Claude / FreeLLMAPI)                          │
│ Immediately persists resolved answer back to Tier 1 in DB   │
└─────────────────────────────────────────────────────────────┘
```

---

## Regex-First & Deterministic Parsing Strategy

Following the `regex-vs-llm-structured-text` framework:
- **95%+ of questions follow standard patterns** (e.g., "Are you legally authorized to work?", "Will you require sponsorship?", "Years of experience", "Highest education level").
- **Deterministic Token Matching First**:
  1. Normalize label string: lowercase, strip punctuation, remove noise words (`please`, `indicate`, `select`).
  2. Evaluate deterministic boolean / regex rules:
     - `require sponsorship` -> `No` (or candidate work status).
     - `authorized to work` -> `Yes`.
     - `18 years of age` -> `Yes`.
     - `previously employed` -> `No`.
  3. Match candidate profile facts directly against live DOM `<option>` elements using token jaccard similarity or substring match.
- **When to Invoke LLM (Tier 4)**:
  - ONLY when deterministic match confidence is below 0.90 or when multi-choice dropdown options do not contain an exact match.
  - This eliminates 95%+ of LLM API calls, cutting prompt costs to near zero and boosting wizard advancement speed by 5x–10x.

---

## Compliance Non-Negotiables (Zero Hallucination)

1. **Demographic & EEO Compliance**:
   - Never guess or fabricate answers for:
     * Race / Ethnicity
     * Gender Identity
     * Disability Status (OFCCP CC-305)
     * Veteran Status
     * Criminal History / Legal Disclosures
   - If a candidate profile lacks an answer for a mandatory compliance field, check for "I choose not to disclose", "Decline to state", or "Prefer not to answer". If unavailable, halt and flag for operator review (`requires_review = true`).

2. **Persistence Guarantee**:
   - Whenever Tier 4 LLM resolves a valid answer from live DOM options, immediately persist it to Supabase `client_questions` or `qa_bank` on conflict `(tenant, normalized_question)` so subsequent runs hit Tier 1 instantly.

---

## Prompt Construction Template (Tier 4)

When LLM inference is necessary:

```text
System: You are an expert ATS form resolution assistant. Select the single best matching option for the applicant based strictly on their verified profile facts. Never hallucinate answers.

Candidate Profile:
{candidate_facts_json}

Workday Question:
"{question_label}"

Available Options on Live DOM:
- Option A: "..."
- Option B: "..."
- Option C: "..."

Instructions:
1. Return ONLY the exact text of the matching option.
2. If the applicant's facts do not indicate an answer, select the standard neutral option ("Decline to answer" or "Not specified") if available.
```
