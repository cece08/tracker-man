// Modèles de données (miroir des tables Supabase, voir supabase/schema.sql)

export type Role = 'hunter' | 'hunted';
export type Status = 'lobby' | 'playing' | 'ended';

export interface Settings {
  total: number;        // durée totale (min)
  headStart: number;    // avance des chassés (min)
  radiusStart: number;  // rayon initial (m)
  radiusEnd: number;    // rayon final (m)
  shrinkEvery: number;  // intervalle de rétrécissement (min)
  roleMode: 'random' | 'manual';
  hunters: number;      // nombre de chasseurs en mode aléatoire
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

export interface Circle { lat: number; lng: number; r: number; t: number; }
export interface Pos { lat: number; lng: number; t: number; }

export interface Player {
  session_code: string;
  id: string;
  name: string;
  role: Role;
  initial_role: Role | null;
  catch_code: string;
  joined_at: number;
  caught_by: string | null;
  caught_at: number | null;
  circle: Circle | null;
  pos: Pos | null;
  seen: number | null;
}

export interface GameEvent {
  id: number;
  session_code: string;
  type: 'start' | 'caught';
  t: number;
  data: { victim?: string; victimName?: string; hunter?: string; hunterName?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  total: 60, headStart: 5, radiusStart: 500, radiusEnd: 50, shrinkEvery: 10, roleMode: 'random', hunters: 1,
};
