import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutizeApplyWizzResumeUrl, resolveApplyWizzResumeUrl } from './applyWizzResume.mjs';

test('absolutizeApplyWizzResumeUrl — https unchanged', () => {
  const url = 'https://cdn.example.com/r.pdf';
  assert.equal(absolutizeApplyWizzResumeUrl(url), url);
});

test('absolutizeApplyWizzResumeUrl — relative path under apply-wizz host', () => {
  assert.equal(
    absolutizeApplyWizzResumeUrl('/uploads/client/resume.pdf'),
    'https://www.apply-wizz.me/uploads/client/resume.pdf',
  );
});

test('resolveApplyWizzResumeUrl — profile overlay + client context', () => {
  const profile = {
    _resumeUrl: '/files/resume.pdf',
    _applyWizzClientContext: {
      additional_information: { resume_url: 'https://other.example/x.pdf' },
    },
  };
  assert.equal(resolveApplyWizzResumeUrl(profile), 'https://www.apply-wizz.me/files/resume.pdf');
});
