// Configuration Supabase de Tracker Man.
// Remplace ces valeurs par celles de TON projet :
// Supabase > Project Settings > API (ou "Connect") > Project URL + clé "anon / publishable".
// La clé anon est publique par conception : elle peut être commitée sans risque.
export const SUPABASE_URL = 'https://REMPLACER.supabase.co';
export const SUPABASE_ANON_KEY = 'REMPLACER';

export const SUPABASE_CONFIGURED = !SUPABASE_URL.includes('REMPLACER') && !SUPABASE_ANON_KEY.includes('REMPLACER');
