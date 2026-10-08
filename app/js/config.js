// Public settings for the optional cloud features (accounts, online backup, reminders).
// Empty values switch those features off. None of these are secrets.
const override = globalThis.__PANTRI_CONFIG__ || {};
export const SUPABASE_URL = override.SUPABASE_URL ?? 'https://akdvcyvjcshfthuzgdsp.supabase.co';
export const SUPABASE_ANON_KEY = override.SUPABASE_ANON_KEY ?? 'sb_publishable_lXsvCOMMtKJX9s6lXKa0tw_06hXg6rl';
export const VAPID_PUBLIC_KEY = override.VAPID_PUBLIC_KEY ?? 'BOgcLdL15hQWClEYgh2-iKTId5gpmb8gf7rwucBHfQVUfhMVXurQjlczQ7JmORjOuHi3qfJwywjuFObux4kLaFs';
