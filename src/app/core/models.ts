// Modèles de données P2P E2EE (100 % en mémoire vive — zéro base de données)

export type Role = 'hunter' | 'hunted';
export type Status = 'lobby' | 'playing' | 'ended';

export interface Zone {
  lat: number;
  lng: number;
  r: number; // rayon autorisé en mètres
}

export interface Settings {
  total: number;        // durée totale (min)
  headStart: number;    // avance des chassés (min)
  radiusStart: number;  // rayon initial (m)
  radiusEnd: number;    // rayon final (m)
  shrinkEvery: number;  // intervalle de rétrécissement (min)
  roleMode: 'random' | 'manual';
  hunters: number;      // nombre de chasseurs en mode aléatoire
  zone?: Zone | null;   // zone autorisée (optionnelle, chiffrée de bout en bout)
  outGraceSec?: number; // secondes autorisées hors zone avant élimination
  circleRefreshSec?: number | null; // actualisation périodique du cercle en secondes (null = uniquement si sortie/rétrécissement)
}

export interface Session {
  code: string;
  host_id: string;
  status: Status;
  settings: Settings;
  start_at: number | null;
  end_at: number | null;
  winner: 'hunted' | 'hunters' | null;
  ended_at: number | null;
}

export type AllyShareMode = 'off' | 'relative' | 'exact';

export interface Circle { lat: number; lng: number; r: number; t: number; allyShare?: boolean; }
export interface Pos { lat: number; lng: number; t: number; role?: Role; }

export interface Player {
  session_code: string;
  id: string;
  name: string;
  role: Role;
  initial_role: Role | null;
  catch_code: string;        // toujours '****' sur le réseau (le vrai code reste sur l'appareil du joueur)
  catch_commitment?: string; // engagement PBKDF2-SHA-256 (60 000 itérations) du code chasseur
  pub_key?: string;          // clé publique ECDSA P-256 (SPKI Base64) authentifiant chaque action
  ecdh_key?: string;         // clé publique ECDH P-256 (SPKI Base64) pour l'accord de clés Zero-Knowledge
  joined_at: number;
  caught_by: string | null;  // ID du chasseur ou 'ZONE' si éliminé hors zone
  caught_at: number | null;
  circle: Circle | null;
  pos: Pos | null;
  seen: number | null;
}

export interface GameEvent {
  id: number;
  session_code: string;
  type: 'start' | 'caught' | 'out_of_zone' | 'pos' | 'track';
  t: number;
  data: {
    victim?: string;
    victimName?: string;
    hunter?: string;
    hunterName?: string;
    lat?: number;
    lng?: number;
    role?: Role;
    playerId?: string;
    playerName?: string;
    points?: Pos[];
  };
}

export const DEFAULT_SETTINGS: Settings = {
  total: 60,
  headStart: 5,
  radiusStart: 500,
  radiusEnd: 50,
  shrinkEvery: 10,
  roleMode: 'random',
  hunters: 1,
  zone: null,
  outGraceSec: 30,
  circleRefreshSec: null,
};
