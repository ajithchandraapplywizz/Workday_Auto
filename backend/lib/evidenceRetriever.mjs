import { createClient } from '@supabase/supabase-js';

// Retrieve evidence for a specific intent.
// Scoped strictly to (candidate_id, workday_tenant) for isolation.
// Tiers:
// 1. QA cache (tenant-scoped, from supabase or local cache if we load it)
// 2. CRM API (or Supabase client details)
// 3. Resume facts (from Supabase client_facts table)
// Returns {status: 'found', value, source, evidence, tier}, {status: 'no_evidence'}, or {status: 'unavailable'}
export async function retrieveEvidence(candidateId, tenant, intentKey, options = {}) {
  if (!candidateId || !tenant || !intentKey) {
    return { status: 'no_evidence' };
  }

  let supabase = options.db;
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error('CRITICAL: Supabase not configured for Evidence Retriever');
      return { status: 'unavailable' };
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }

  try {
    // Tier 1: QA cache (tenant-scoped)
    const { data: qaData, error: qaError } = await supabase
      .from('qa_answers')
      .select('answer_value, source')
      .eq('candidate_id', candidateId)
      .eq('tenant', tenant)
      .eq('intent_key', intentKey)
      .single();

    if (qaError && qaError.code !== 'PGRST116') { // PGRST116 is not found
      console.error('Evidence Retriever query error (QA cache):', qaError);
      return { status: 'unavailable' };
    }

    if (qaData && qaData.answer_value !== null) {
      return {
        status: 'found',
        value: qaData.answer_value,
        source: qaData.source || 'qa_cache',
        evidence: 'Retrieved from prior tenant QA cache',
        tier: 1
      };
    }

    // Tier 2 & 3: CRM API & Resume facts
    const { data: factData, error: factError } = await supabase
      .from('client_facts')
      .select('value, source, evidence_text')
      .eq('candidate_id', candidateId)
      .eq('intent_key', intentKey)
      .order('confidence', { ascending: false })
      .limit(1)
      .single();

    if (factError && factError.code !== 'PGRST116') {
      console.error('Evidence Retriever query error (Facts):', factError);
      return { status: 'unavailable' };
    }

    if (factData && factData.value) {
      let tier = 3;
      if (factData.source === 'crm' || factData.source === 'supabase') {
        tier = 2;
      }
      
      let parsedValue = factData.value;
      if (typeof parsedValue === 'string') {
          try { parsedValue = JSON.parse(parsedValue); } catch(e) {}
      }

      return {
        status: 'found',
        value: parsedValue?.text || parsedValue,
        source: factData.source,
        evidence: factData.evidence_text || 'Retrieved from offline fact extraction',
        tier
      };
    }

    return { status: 'no_evidence' };
  } catch (error) {
    console.error('CRITICAL: Unexpected error in retrieveEvidence', error);
    return { status: 'unavailable' };
  }
}
