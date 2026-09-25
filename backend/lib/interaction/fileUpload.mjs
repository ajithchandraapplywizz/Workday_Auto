import { failResult } from './_result.mjs';

/**
 * Resume / file inputs stay with the existing upload module.
 * This handler never invents a path or opens the OS picker.
 */
export async function fillFileUpload(_page, field, _answer, _ctx = {}) {
  return failResult(field, 'file_owned_by_resume_module', { recoverable: false });
}
