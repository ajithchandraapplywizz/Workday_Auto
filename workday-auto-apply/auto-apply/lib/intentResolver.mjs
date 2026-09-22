import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import * as fuzzball from 'fuzzball';
import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const intentsPath = resolve(__dirname, '../config/intents.yml');
let intentsCache = null;

function loadIntents() {
  if (intentsCache) return intentsCache;
  if (!existsSync(intentsPath)) {
    console.warn('config/intents.yml not found');
    return [];
  }
  const file = readFileSync(intentsPath, 'utf8');
  const parsed = yaml.parse(file);
  intentsCache = parsed.intents || [];
  return intentsCache;
}

// 1. Automation ID Map (Hardcoded common workday mappings)
const AUTOMATION_ID_MAP = {
  'degree': 'education.degree',
  'fieldOfStudy': 'education.field_of_study',
  'veteranStatus': 'eeo.veteran',
  'disabilityStatus': 'eeo.disability',
  'gender': 'eeo.gender',
  'race': 'eeo.race',
};

// Derive control type exclusively from DOM properties, never from label text
export function deriveControlTypeFromDom(fieldDescriptor) {
  // Use explicit roles/tags found during mechanical DOM extraction
  const { elementType, role, ariaHasPopup } = fieldDescriptor;
  
  if (elementType === 'select' || role === 'listbox' || ariaHasPopup === 'listbox') {
    return 'dropdown';
  }
  if (elementType === 'radio' || role === 'radio') {
    return 'radio';
  }
  if (elementType === 'checkbox' || role === 'checkbox') {
    return 'checkbox';
  }
  if (elementType === 'file') {
    return 'file';
  }
  if (elementType === 'date' || role === 'combobox' && fieldDescriptor.id?.includes('date')) {
    // Basic heuristic for dates
    return 'date';
  }
  
  return 'text'; // Default to text
}

async function resolveWithLLM(label, controlType) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
  });

  const prompt = `Classify the following form field label into an intent. 
Label: "${label}"
Control Type: "${controlType}"

Output a JSON object with 'intent' (string, or null if unknown) and 'confidence' (number 0-1).`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 150,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const content = msg.content[0].text;
    const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1);
    const result = JSON.parse(jsonStr);
    
    return {
      intent: result.intent,
      method: 'llm',
      confidence: result.confidence || 0.8
    };
  } catch (e) {
    console.error('LLM intent resolution failed:', e.message);
    return null;
  }
}

export async function resolveIntent(fieldDescriptor) {
  const { label, automationId } = fieldDescriptor;
  const controlType = deriveControlTypeFromDom(fieldDescriptor);
  
  // 1. Automation-id map
  if (automationId && AUTOMATION_ID_MAP[automationId]) {
    return {
      intent: AUTOMATION_ID_MAP[automationId],
      controlType,
      confidence: 1.0,
      method: 'automation-id'
    };
  }

  const normalizedLabel = String(label || '').toLowerCase().trim();
  if (!normalizedLabel) {
    return { intent: null, controlType, confidence: 0, method: 'none' };
  }

  // 2. Fuzzball on the label
  const taxonomy = loadIntents();
  let bestMatch = null;
  let highestScore = 0;

  for (const intentObj of taxonomy) {
    for (const syn of intentObj.labels) {
      const score = fuzzball.token_set_ratio(normalizedLabel, syn);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = intentObj.id;
      }
    }
  }

  if (highestScore >= 85 && bestMatch) {
    return {
      intent: bestMatch,
      controlType,
      confidence: highestScore / 100,
      method: 'fuzzball'
    };
  }

  // 3. (Stub) Embeddings
  // TODO: implement local huggingface embeddings lookup

  // 4. LLM Classify (ambiguous only)
  const llmResult = await resolveWithLLM(normalizedLabel, controlType);
  if (llmResult && llmResult.intent) {
    return {
      intent: llmResult.intent,
      controlType,
      confidence: llmResult.confidence,
      method: 'llm'
    };
  }

  return { intent: null, controlType, confidence: 0, method: 'none' };
}
