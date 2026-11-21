import test from 'node:test';
import assert from 'node:assert/strict';
import { isResumeAuthenticForCandidate } from '../lib/applyWizzResume.mjs';

test('isResumeAuthenticForCandidate: Ajay Sai Pallerla (AWL-46682) authentic signals pass', () => {
  const profile = {
    client_name: 'Ajay Sai Pallerla',
    personal: {
      first_name: 'Ajay Sai',
      last_name: 'Pallerla',
      email: 'pallerla.ajaysai@applywizard.ai',
      phone_number: '+1 (614) 670-0665'
    },
    _dbClient: {
      company_email: 'pallerla.ajaysai@applywizard.ai',
      personal_email: 'ajaysai.pallerla@gmail.com',
      callable_phone: '+16146700665'
    }
  };

  // Typical text extracted from AWL-46682 PDF (Header: "P AJAY SAI", email: "pallerla.ajaysai@applywizard.ai")
  const extractedText = `
    P AJAY SAI
    Full Stack Developer | Cloud & AI Automation
    Email: pallerla.ajaysai@applywizard.ai | Phone: (614) 670-0665 | Columbus, OH
    Summary:
    Experienced Software Engineer with a demonstrated history of working with React, Node.js, and Cloud Infrastructure.
  `;

  assert.equal(isResumeAuthenticForCandidate(extractedText, profile), true, 'Authentic candidate resume must pass verification');
});

test('isResumeAuthenticForCandidate: passes via email prefix even if domain differs', () => {
  const profile = {
    client_name: 'Ajay Sai Pallerla',
    personal: {
      first_name: 'Ajay Sai',
      last_name: 'Pallerla',
      email: 'pallerla.ajaysai@applywizard.ai'
    }
  };

  const extractedText = `
    P AJAY SAI
    Contact: pallerla.ajaysai@gmail.com
    Experience: Senior Software Engineer at Leading Tech Firm.
    Built automated pipelines and full stack React applications.
  `;

  assert.equal(isResumeAuthenticForCandidate(extractedText, profile), true, 'Email prefix match must pass');
});

test('isResumeAuthenticForCandidate: passes via phone digits even without email or full name string', () => {
  const profile = {
    client_name: 'Ajay Sai Pallerla',
    personal: {
      first_name: 'Ajay Sai',
      last_name: 'Pallerla',
      phone_number: '+1 (614) 670-0665'
    }
  };

  const extractedText = `
    PROFESSIONAL PROFILE
    Contact: 614-670-0665
    Key Skills: React, Node.js, PostgreSQL, Docker, AWS, Cloud Platforms.
    Over 5 years of hands-on software development experience.
  `;

  assert.equal(isResumeAuthenticForCandidate(extractedText, profile), true, 'Phone number digits match must pass');
});

test('isResumeAuthenticForCandidate: passes via individual significant name token (>= 3 chars)', () => {
  const profile = {
    client_name: 'Ajay Sai Pallerla',
    personal: {
      first_name: 'Ajay Sai',
      last_name: 'Pallerla'
    }
  };

  const extractedText = `
    Summary of Qualifications
    Candidate: P. Ajay S.
    Extensive experience in software engineering and automated web testing.
    Over 10 years building scalable microservices and backend architectures.
  `;

  assert.equal(isResumeAuthenticForCandidate(extractedText, profile), true, 'Token "ajay" must match');
});

test('isResumeAuthenticForCandidate: rejects corrupted / mismatched resume from another candidate', () => {
  const profile = {
    client_name: 'Vadiraja Korlahalli',
    personal: {
      first_name: 'Vadiraja',
      last_name: 'Korlahalli',
      email: 'vadiraja.k@applywizard.ai',
      phone_number: '+1 (555) 234-5678'
    }
  };

  // Mismatched text from Dinesh Naidu Thota
  const extractedText = `
    DINESH NAIDU THOTA
    Data Scientist & Machine Learning Engineer
    Email: dinesh.naidu@gmail.com | Phone: (987) 654-3210 | Austin, TX
    Expertise in Python, PyTorch, TensorFlow, and NLP pipelines.
  `;

  assert.equal(isResumeAuthenticForCandidate(extractedText, profile), false, 'Mismatched candidate resume must be rejected as unauthentic');
});

test('isResumeAuthenticForCandidate: rejects invalid, short, or empty text', () => {
  const profile = { client_name: 'Test Candidate' };
  assert.equal(isResumeAuthenticForCandidate('', profile), false);
  assert.equal(isResumeAuthenticForCandidate('Too short text', profile), false);
  assert.equal(isResumeAuthenticForCandidate(null, profile), false);
});
