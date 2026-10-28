/**
 * tenantQuestionYaml.mjs
 * Optional tenant-specific YAML question lookup handler
 */
export function lookupTenantAnswer(tenant, rawLabel, options = {}) {
  // Tenant-specific YAML override hook; returns null to fall back to universal Q&A
  return null;
}
