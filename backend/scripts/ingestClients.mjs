import { createClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import dotenv from 'dotenv';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import pdfParse from 'pdf-parse';
import { z } from 'zod';
import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

const limit = pLimit(5);

const ExtractionSchema = z.object({
  education: z.object({
    degree: z.string().nullable(),
    school: z.string().nullable(),
    field_of_study: z.string().nullable(),
  }),
  work: z.object({
    current_company: z.string().nullable(),
    title: z.string().nullable(),
  })
});

async function downloadResume(s3Key) {
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: s3Key,
    });
    const response = await s3.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    console.error(`S3 Error for ${s3Key}: ${err.message}`);
    return null;
  }
}

async function extractFactsWithLLM(text) {
  const prompt = `Extract the following facts from this resume text. Only output a strict JSON object matching this structure:
{
  "education": {
    "degree": "string or null",
    "school": "string or null",
    "field_of_study": "string or null"
  },
  "work": {
    "current_company": "string or null",
    "title": "string or null"
  }
}

Resume Text:
${text}
`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    const content = msg.content[0].text;
    const jsonStr = content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1);
    return ExtractionSchema.parse(JSON.parse(jsonStr));
  } catch (e) {
    console.error('LLM Extraction failed:', e.message);
    return null;
  }
}

async function processClient(clientId) {
  console.log(`Processing client: ${clientId}`);
  try {
    // 1. Fetch from CRM
    const res = await fetch(`https://apply-wizz.me/api/get-client-details?id=${clientId}`, {
      headers: { 'Authorization': `Bearer ${process.env.CRM_API_KEY || ''}` }
    });
    
    if (!res.ok) throw new Error(`CRM API failed with ${res.status}`);
    const clientData = await res.json();
    const s3Key = clientData.resume_s3_key; // Assuming this field exists

    if (!s3Key) {
      console.log(`No resume found for ${clientId}`);
      return { clientId, success: false, reason: 'No resume' };
    }

    // 2. Download and parse resume
    const pdfBuffer = await downloadResume(s3Key);
    if (!pdfBuffer) throw new Error('Resume download failed');
    
    const pdfData = await pdfParse(pdfBuffer);
    const resumeText = pdfData.text;

    // 3. Extract facts using LLM
    const facts = await extractFactsWithLLM(resumeText);
    if (!facts) throw new Error('LLM extraction failed');

    // 4. Upsert into client_facts
    const upserts = [];
    if (facts.education.degree) {
      upserts.push({
        candidate_id: clientId,
        intent_key: 'education.degree',
        value: JSON.stringify({ text: facts.education.degree }),
        source: 'resume',
        evidence_text: facts.education.degree,
        confidence: 0.9
      });
    }
    // (Add other facts as needed...)

    if (upserts.length > 0) {
      const { error } = await supabase
        .from('client_facts')
        .upsert(upserts, { onConflict: 'candidate_id,intent_key' });
      if (error) throw new Error(`Supabase upsert error: ${error.message}`);
    }

    return { clientId, success: true, factsExtracted: upserts.length };
  } catch (error) {
    console.error(`Failed ${clientId}: ${error.message}`);
    return { clientId, success: false, reason: error.message };
  }
}

async function run() {
  console.log('Starting ingestion...');
  
  const txtPath = './sync_ids.txt';
  let allClients = [];
  if (fs.existsSync(txtPath)) {
    allClients = fs.readFileSync(txtPath, 'utf8')
      .split('\\n')
      .map(i => i.trim())
      .filter(Boolean);
  } else {
    console.error('No sync_ids.txt found.');
    return;
  }
  
  const tasks = allClients.map(id => limit(() => processClient(id)));
  const results = await Promise.all(tasks);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`\\n--- Ingestion Report ---`);
  console.log(`Total Clients: ${allClients.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);
  
  if (failed.length > 0) {
    console.log('Failures:', failed.map(f => `${f.clientId} (${f.reason})`));
  }
}

run().catch(console.error);
