import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHardcodedInternDescription,
  deriveRoleDescriptionFromResumeText,
  resolveCandidateRoleDescription,
} from '../lib/roleDescriptionResolver.mjs';

test('isHardcodedInternDescription accurately detects obsolete hardcoded description', () => {
  assert.equal(
    isHardcodedInternDescription("Full stack Intern developed websites and automation worked with agents Rags and LLM's"),
    true
  );
  assert.equal(
    isHardcodedInternDescription("full stack intern developed websites and automation"),
    true
  );
  assert.equal(
    isHardcodedInternDescription("Led DevOps automation and deployed Kubernetes microservices on AWS cloud."),
    false
  );
  assert.equal(isHardcodedInternDescription(""), false);
  assert.equal(isHardcodedInternDescription(null), false);
});

test('deriveRoleDescriptionFromResumeText extracts genuine responsibilities from resume experience block', () => {
  const sampleResume = `
Naveen Kumar
Software Engineer | Dallas, TX

PROFESSIONAL EXPERIENCE
Senior Software Engineer | Cognizant
Jan 2021 - Present
- Designed and maintained scalable RESTful APIs using Node.js and TypeScript for enterprise clients.
- Automated CI/CD deployment pipelines using GitHub Actions and Docker, reducing release cycle by 35%.
- Collaborated with cross-functional teams to deliver secure financial transaction services.

EDUCATION
University of Texas at Dallas
Master of Science in Computer Science
  `;

  const profile = {
    experience: {
      current_title: 'Senior Software Engineer',
      current_company: 'Cognizant',
    },
    skills: ['Node.js', 'TypeScript', 'Docker'],
  };

  const desc = deriveRoleDescriptionFromResumeText(sampleResume, profile);
  assert.ok(desc.length > 30, 'Generated description should be substantial');
  assert.ok(!isHardcodedInternDescription(desc), 'Generated description must NOT be the hardcoded intern string');
  assert.ok(desc.includes('RESTful APIs') || desc.includes('Node.js') || desc.includes('CI/CD'), 'Should contain authentic resume details');
});

test('resolveCandidateRoleDescription utilizes QA bank priority and cleans out hardcoded descriptions', async () => {
  // Test Case A: Valid dynamic description in QA Bank -> Instant 0-token hit
  const profileWithQa = {
    _applyWizzId: 'AWL-TEST-001',
    _supabaseQa: {
      'role description': 'Architected distributed systems in Go and Kubernetes, scaling backend throughput.',
    },
    experience: {},
  };

  const ansA = await resolveCandidateRoleDescription(profileWithQa);
  assert.equal(ansA, 'Architected distributed systems in Go and Kubernetes, scaling backend throughput.');

  // Test Case B: Stale hardcoded description in QA Bank -> Purged and regenerated dynamically
  const profileWithStaleHardcoded = {
    _applyWizzId: 'AWL-TEST-002',
    _supabaseQa: {
      'role description': "Full stack Intern developed websites and automation worked with agents Rags and LLM's",
    },
    _resumeText: `
EXPERIENCE
DevOps Cloud Engineer | Acme Corp
2022 - Present
- Managed Terraform infrastructure for AWS cloud resources and provisioned EKS clusters.
- Configured Prometheus and Grafana dashboards for cluster-wide reliability monitoring.
    `,
    experience: {
      current_title: 'DevOps Cloud Engineer',
      current_company: 'Acme Corp',
    },
  };

  const ansB = await resolveCandidateRoleDescription(profileWithStaleHardcoded);
  assert.ok(!isHardcodedInternDescription(ansB), 'Must purge stale hardcoded description');
  assert.ok(ansB.includes('Terraform') || ansB.includes('AWS cloud') || ansB.includes('DevOps Cloud Engineer'));
  assert.equal(profileWithStaleHardcoded._supabaseQa['role description'], ansB, 'In-memory QA cache must be updated');
});
