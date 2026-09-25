/**
 * Structured orchestrator logs — ids and outcomes, not raw PII dumps.
 */

export function logOrchestrator(event, payload = {}) {
  const rec = {
    timestamp: new Date().toISOString(),
    event,
    ...payload,
  };
  const extra = Object.entries(payload)
    .filter(([k]) => k !== 'timestamp')
    .map(([k, v]) => `${k}=${String(v ?? '').slice(0, 60)}`)
    .join(' ');
  console.log(`  🧭 [${event}] ${extra}`);
  return rec;
}
