// Public settings for the optional cloud features (accounts, online backup, reminders).
// Empty values switch those features off. None of these are secrets.
const override = globalThis.__PANTRI_CONFIG__ || {};
export const SUPABASE_URL = override.SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = override.SUPABASE_ANON_KEY ?? '';
export const VAPID_PUBLIC_KEY = override.VAPID_PUBLIC_KEY ?? '';
