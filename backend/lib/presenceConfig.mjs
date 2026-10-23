/**
 * presenceConfig.mjs — Presence & Session Configuration
 * ====================================================
 * Configures session lifetime, presence windows, and throttling intervals.
 */

export const presenceConfig = {
  SESSION_MAX_AGE_HOURS: 12, // 12 hours JWT session lifetime
  ONLINE_WINDOW_MINUTES: 2,  // 2 minutes for active presence
  HEARTBEAT_THROTTLE_SECONDS: 30, // Rate limit DB writes to 30s
  MAX_FAILED_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
};

export const SESSION_MAX_AGE_HOURS = presenceConfig.SESSION_MAX_AGE_HOURS;
export const PRESENCE_ONLINE_WINDOW_MS = presenceConfig.ONLINE_WINDOW_MINUTES * 60 * 1000;
export const HEARTBEAT_DB_THROTTLE_MS = presenceConfig.HEARTBEAT_THROTTLE_SECONDS * 1000;
export default presenceConfig;
