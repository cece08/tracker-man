// Configuration Supabase de Tracker Man.
// La clé publishable / anon est publique par conception : elle peut être commitée sans risque.
export const SUPABASE_URL = 'https://dcbalwxozbxerwxivljl.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_OzlubLrsFqJzBzuvt9slrw_10nxoScA';

export const SUPABASE_CONFIGURED = !SUPABASE_URL.includes('REMPLACER') && !SUPABASE_ANON_KEY.includes('REMPLACER');
