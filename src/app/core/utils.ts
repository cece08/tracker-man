// Utilitaires géographiques, formatage et primitives CSPRNG (Web Crypto API)

export interface LatLng { lat: number; lng: number; }
export { sanitizeName } from './crypto.service';

const R_EARTH = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Génère un entier aléatoire cryptographiquement sûr dans [0, maxExclusive)
 * par échantillonnage par rejet (sans biais de modulo, conforme NIST SP 800-90A / ANSSI).
 */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const maxUint32 = 0xffffffff;
  const limit = maxUint32 - (maxUint32 % maxExclusive);
  const buf = new Uint32Array(1);
  let val = 0;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val >= limit);
  return val % maxExclusive;
}

/**
 * Génère un nombre flottant aléatoire cryptographiquement sûr dans [0, 1)
 * avec 53 bits de mantisse IEEE 754 (remplace intégralement Math.random()).
 */
export function secureRandomUnit(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const high = buf[0] >>> 5; // 27 bits
  const low = buf[1] >>> 6;  // 26 bits
  return (high * 67108864 + low) / 9007199254740992;
}

/** Mélange de Fisher-Yates cryptographiquement sûr (CSPRNG). */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Distance en mètres entre deux points (haversine). */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** Point situé à `dist` mètres de `p` dans la direction `bearingDeg`. */
export function destPoint(p: LatLng, dist: number, bearingDeg: number): LatLng {
  const d = dist / R_EARTH, br = toRad(bearingDeg), lat1 = toRad(p.lat), lng1 = toRad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  // Quantification à 5 décimales (~1.1 m) pour éviter toute fuite par canal auxiliaire IEEE-754
  return {
    lat: Number(toDeg(lat2).toFixed(5)),
    lng: Number(toDeg(lng2).toFixed(5)),
  };
}

/** Durée en ms -> "m:ss" ou "h:mm:ss". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Timestamp -> "HH:MM". */
export function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (n = 6) =>
  Array.from({ length: n }, () => CODE_CHARS[secureRandomInt(CODE_CHARS.length)]).join('');
export const random4 = () => String(secureRandomInt(10000)).padStart(4, '0');

export function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* non supporté */ }
}
