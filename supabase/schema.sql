-- =====================================================================
-- Tracker Man – schéma Supabase SÉCURISÉ
-- À exécuter dans : Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- 1. Tables publiques ----------
create table if not exists public.sessions (
  code       text primary key check (code ~ '^[A-Z0-9]{6}$'),
  host_id    text not null,
  status     text not null default 'lobby' check (status in ('lobby', 'playing', 'ended')),
  settings   jsonb not null,
  start_at   bigint,
  end_at     bigint,
  winner     text check (winner in ('hunted', 'hunters')),
  ended_at   bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  session_code text not null references public.sessions(code) on delete cascade,
  id           text not null,
  name         text not null check (char_length(name) between 1 and 20),
  role         text not null default 'hunted' check (role in ('hunter', 'hunted')),
  initial_role text,
  catch_code   text not null default '****', -- masqué dans la table publique (le vrai code est dans player_secrets)
  joined_at    bigint not null,
  caught_by    text,    -- ID du chasseur ou 'ZONE' si éliminé hors zone
  caught_at    bigint,
  circle       jsonb,   -- { lat, lng, r, t } : cercle approximatif d'un chassé
  pos          jsonb,   -- { lat, lng, t }    : position exacte d'un chasseur
  seen         bigint,  -- dernier signal GPS
  primary key (session_code, id)
);

create table if not exists public.events (
  id           bigint generated always as identity primary key,
  session_code text not null references public.sessions(code) on delete cascade,
  type         text not null check (type in ('start', 'caught', 'out_of_zone', 'pos', 'track')),
  t            bigint not null,
  data         jsonb not null default '{}'::jsonb
);
create index if not exists events_session_idx on public.events(session_code);

-- ---------- 2. Table privée (inaccessible aux clients : RLS activée sans policy) ----------
create table if not exists public.player_secrets (
  session_code text not null references public.sessions(code) on delete cascade,
  player_id    text not null,
  secret_hash  text not null, -- SHA-256 du jeton secret du joueur (anti-usurpation)
  catch_code   text not null, -- vrai code chasseur à 4 chiffres (invisible dans le réseau pour les autres)
  primary key (session_code, player_id)
);

-- ---------- 3. Sécurité RLS : lecture seule pour le client, zéro écriture directe ----------
alter table public.sessions       enable row level security;
alter table public.players        enable row level security;
alter table public.events         enable row level security;
alter table public.player_secrets enable row level security;

drop policy if exists "public access" on public.sessions;
drop policy if exists "public access" on public.players;
drop policy if exists "public access" on public.events;
drop policy if exists "read_only_sessions" on public.sessions;
drop policy if exists "read_only_players"  on public.players;
drop policy if exists "read_only_events"   on public.events;

-- Les clients peuvent uniquement LIRE les sessions/joueurs/events (nécessaire pour Supabase Realtime).
-- Aucune politique INSERT/UPDATE/DELETE : toute modification directe depuis la console F12 est refusée.
create policy "read_only_sessions" on public.sessions for select to anon, authenticated using (true);
create policy "read_only_players"  on public.players  for select to anon, authenticated using (true);
create policy "read_only_events"   on public.events   for select to anon, authenticated using (true);
-- player_secrets n'a AUCUNE policy : même un SELECT depuis le client renvoie 0 ligne.

-- ---------- 4. Temps réel ----------
do $$
begin
  begin alter publication supabase_realtime add table public.sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.players;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.events;   exception when duplicate_object then null; end;
end $$;

-- ---------- 5. Utilitaires internes ----------
create extension if not exists pgcrypto;

create or replace function public.now_ms() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.server_now() returns bigint
language sql volatile as $$ select public.now_ms() $$;

create or replace function public.hash_secret(p_secret text) returns text
language sql immutable as $$ select encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex') $$;

-- Vérifie que l'appelant possède bien le secret du joueur p_id dans la session p_code
create or replace function public.assert_player(p_code text, p_id text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.player_secrets
     where session_code = p_code and player_id = p_id and secret_hash = public.hash_secret(p_secret)
  ) then
    raise exception 'Action non autorisée (jeton joueur invalide)';
  end if;
end $$;

-- Vérifie que l'appelant est bien l'hôte de la session p_code
create or replace function public.assert_host(p_code text, p_id text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
declare h text;
begin
  perform public.assert_player(p_code, p_id, p_secret);
  select host_id into h from public.sessions where code = p_code;
  if h is distinct from p_id then
    raise exception 'Seul l''hôte de la session peut effectuer cette action';
  end if;
end $$;

-- ---------- 6. Fonctions RPC sécurisées (SECURITY DEFINER) ----------

-- Créer une session + inscrire l'hôte avec son secret
create or replace function public.create_session_secure(
  p_code text, p_host_id text, p_secret text, p_name text, p_settings jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare c text := lpad(floor(random() * 10000)::int::text, 4, '0');
begin
  if length(coalesce(p_secret, '')) < 16 then raise exception 'Secret trop court'; end if;
  insert into public.sessions(code, host_id, status, settings)
  values (p_code, p_host_id, 'lobby', p_settings);

  insert into public.players(session_code, id, name, catch_code, joined_at)
  values (p_code, p_host_id, trim(left(p_name, 20)), '****', public.now_ms());

  insert into public.player_secrets(session_code, player_id, secret_hash, catch_code)
  values (p_code, p_host_id, public.hash_secret(p_secret), c);
end $$;

-- Rejoindre une session (ou se reconnecter si on possède déjà le bon secret)
create or replace function public.join_session(
  p_code text, p_id text, p_name text, p_secret text default ''
) returns void
language plpgsql security definer set search_path = public as $$
declare s record; c text;
begin
  if length(coalesce(p_secret, '')) < 16 then raise exception 'Secret invalide'; end if;
  select * into s from public.sessions where code = p_code;
  if not found then raise exception 'Session introuvable'; end if;

  if exists (select 1 from public.players where session_code = p_code and id = p_id) then
    perform public.assert_player(p_code, p_id, p_secret);
    update public.players set name = trim(left(p_name, 20)) where session_code = p_code and id = p_id;
    return;
  end if;

  if s.status <> 'lobby' then raise exception 'La partie a déjà commencé'; end if;
  c := lpad(floor(random() * 10000)::int::text, 4, '0');
  insert into public.players(session_code, id, name, catch_code, joined_at)
  values (p_code, p_id, trim(left(p_name, 20)), '****', public.now_ms());

  insert into public.player_secrets(session_code, player_id, secret_hash, catch_code)
  values (p_code, p_id, public.hash_secret(p_secret), c);
end $$;

-- Récupérer uniquement SON propre code chasseur (impossible de lire celui d'un autre)
create or replace function public.get_my_catch_code(p_code text, p_id text, p_secret text) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  perform public.assert_player(p_code, p_id, p_secret);
  select catch_code into c from public.player_secrets where session_code = p_code and player_id = p_id;
  return c;
end $$;

-- Quitter une session (authentifié par son secret)
create or replace function public.leave_session(p_code text, p_id text, p_secret text default '') returns void
language plpgsql security definer set search_path = public as $$
declare s record; next_host text;
begin
  perform public.assert_player(p_code, p_id, p_secret);
  delete from public.player_secrets where session_code = p_code and player_id = p_id;
  delete from public.players where session_code = p_code and id = p_id;
  select * into s from public.sessions where code = p_code;
  if not found then return; end if;
  select id into next_host from public.players where session_code = p_code order by joined_at limit 1;
  if next_host is null then
    delete from public.sessions where code = p_code;
  elsif s.host_id = p_id then
    update public.sessions set host_id = next_host where code = p_code;
  end if;
end $$;

-- Modifier les réglages de la session (hôte uniquement, dans le salon)
create or replace function public.update_settings_secure(
  p_code text, p_host_id text, p_secret text, p_settings jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_host(p_code, p_host_id, p_secret);
  update public.sessions set settings = p_settings where code = p_code and status = 'lobby';
end $$;

-- Changer le rôle d'un joueur dans le salon (hôte uniquement)
create or replace function public.toggle_role_secure(
  p_code text, p_host_id text, p_secret text, p_target_id text, p_role text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_host(p_code, p_host_id, p_secret);
  if p_role not in ('hunter', 'hunted') then raise exception 'Rôle invalide'; end if;
  update public.players set role = p_role where session_code = p_code and id = p_target_id;
end $$;

-- Renommer un joueur (soit le joueur lui-même, soit l'hôte)
create or replace function public.rename_player_secure(
  p_code text, p_actor_id text, p_secret text, p_target_id text, p_name text
) returns void
language plpgsql security definer set search_path = public as $$
declare clean text := trim(left(coalesce(p_name, ''), 20));
begin
  if clean = '' then raise exception 'Le pseudo ne peut pas être vide'; end if;
  if p_actor_id = p_target_id then
    perform public.assert_player(p_code, p_actor_id, p_secret);
  else
    perform public.assert_host(p_code, p_actor_id, p_secret);
  end if;
  update public.players set name = clean where session_code = p_code and id = p_target_id;
end $$;

-- Exclure un joueur du salon (hôte uniquement)
create or replace function public.kick_player_secure(
  p_code text, p_host_id text, p_secret text, p_target_id text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_host(p_code, p_host_id, p_secret);
  if p_host_id = p_target_id then return; end if;
  delete from public.player_secrets where session_code = p_code and player_id = p_target_id;
  delete from public.players where session_code = p_code and id = p_target_id;
end $$;

-- Réclamé par le premier joueur en ligne si l'hôte a disparu dans le salon
create or replace function public.claim_host_secure(p_code text, p_id text, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_player(p_code, p_id, p_secret);
  update public.sessions set host_id = p_id where code = p_code and status = 'lobby';
end $$;

-- Lancer la partie (hôte uniquement) : génère des codes chasseurs secrets uniques
create or replace function public.start_game(
  p_code text, p_hunters text[], p_host_id text default null, p_secret text default ''
) returns void
language plpgsql security definer set search_path = public as $$
declare st jsonb; t bigint := public.now_ms(); pl record; used text[] := '{}'; c text; r text;
begin
  if p_host_id is not null then
    perform public.assert_host(p_code, p_host_id, p_secret);
  end if;
  select settings into st from public.sessions where code = p_code and status = 'lobby' for update;
  if not found then raise exception 'Session introuvable ou déjà lancée'; end if;
  for pl in select id from public.players where session_code = p_code loop
    loop
      c := lpad(floor(random() * 10000)::int::text, 4, '0');
      exit when not (c = any(used));
    end loop;
    used := used || c;
    r := case when pl.id = any(p_hunters) then 'hunter' else 'hunted' end;
    update public.players
       set role = r, initial_role = r, catch_code = '****',
           caught_by = null, caught_at = null, circle = null, pos = null, seen = null
     where session_code = p_code and id = pl.id;
    update public.player_secrets set catch_code = c where session_code = p_code and player_id = pl.id;
  end loop;
  delete from public.events where session_code = p_code;
  update public.sessions
     set status = 'playing', start_at = t, end_at = t + (st->>'total')::bigint * 60000,
         winner = null, ended_at = null
   where code = p_code;
  insert into public.events(session_code, type, t) values (p_code, 'start', t);
end $$;

-- Mise à jour de la position / cercle d'un joueur pendant la partie (uniquement sa propre ligne)
create or replace function public.update_my_state(
  p_code text, p_id text, p_secret text, p_pos jsonb, p_circle jsonb, p_seen bigint
) returns void
language plpgsql security definer set search_path = public as $$
declare pl record;
begin
  perform public.assert_player(p_code, p_id, p_secret);
  select role into pl from public.players where session_code = p_code and id = p_id;
  if not found then return; end if;
  if pl.role = 'hunter' then
    update public.players
       set pos = coalesce(p_pos, pos), seen = coalesce(p_seen, seen)
     where session_code = p_code and id = p_id;
  else
    update public.players
       set circle = coalesce(p_circle, circle), seen = coalesce(p_seen, seen)
     where session_code = p_code and id = p_id;
  end if;
end $$;

-- Un chassé se déclare attrapé avec le code chasseur (vérifié dans player_secrets)
create or replace function public.catch_player(
  p_code text, p_victim text, p_catch_code text, p_secret text default ''
) returns text
language plpgsql security definer set search_path = public as $$
declare v record; h record; t bigint := public.now_ms();
begin
  perform public.assert_player(p_code, p_victim, p_secret);
  if not exists (select 1 from public.sessions where code = p_code and status = 'playing') then
    raise exception 'La partie n''est pas en cours';
  end if;
  select * into v from public.players where session_code = p_code and id = p_victim for update;
  if not found or v.role <> 'hunted' then raise exception 'Tu n''es pas chassé'; end if;
  select p.* into h
    from public.players p
    join public.player_secrets s on s.session_code = p.session_code and s.player_id = p.id
   where p.session_code = p_code and p.role = 'hunter' and s.catch_code = p_catch_code and p.id <> p_victim
   limit 1;
  if not found then raise exception 'Code chasseur invalide'; end if;
  update public.players set role = 'hunter', caught_by = h.id, caught_at = t, circle = null
   where session_code = p_code and id = p_victim;
  insert into public.events(session_code, type, t, data)
  values (p_code, 'caught', t, jsonb_build_object('victim', v.id, 'victimName', v.name, 'hunter', h.id, 'hunterName', h.name));
  return h.name;
end $$;

-- Élimination automatique hors zone (authentifiée par le secret du joueur)
create or replace function public.eliminate_out_of_zone_secure(
  p_code text, p_id text, p_secret text
) returns void
language plpgsql security definer set search_path = public as $$
declare v record; t bigint := public.now_ms();
begin
  perform public.assert_player(p_code, p_id, p_secret);
  select * into v from public.players where session_code = p_code and id = p_id for update;
  if not found or v.role <> 'hunted' then return; end if;
  update public.players set role = 'hunter', caught_by = 'ZONE', caught_at = t, circle = null
   where session_code = p_code and id = p_id;
  insert into public.events(session_code, type, t, data)
  values (p_code, 'out_of_zone', t, jsonb_build_object('victim', v.id, 'victimName', v.name));
end $$;

-- Envoi de la trajectoire complète d'un joueur (uniquement quand la partie est terminée)
create or replace function public.submit_track_secure(
  p_code text, p_id text, p_secret text, p_points jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare pl record;
begin
  perform public.assert_player(p_code, p_id, p_secret);
  if not exists (select 1 from public.sessions where code = p_code and status = 'ended') then return; end if;
  if exists (select 1 from public.events where session_code = p_code and type = 'track' and data->>'playerId' = p_id) then
    return;
  end if;
  select name into pl from public.players where session_code = p_code and id = p_id;
  insert into public.events(session_code, type, t, data)
  values (p_code, 'track', public.now_ms(), jsonb_build_object('playerId', p_id, 'playerName', pl.name, 'points', p_points));
end $$;

-- Termine la partie si le temps est écoulé ou s'il ne reste plus de chassés
create or replace function public.end_game(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare t bigint := public.now_ms();
begin
  update public.sessions
     set status = 'ended', ended_at = t,
         winner = case when t >= end_at then 'hunted' else 'hunters' end
   where code = p_code and status = 'playing'
     and (t >= end_at or not exists (select 1 from public.players where session_code = p_code and role = 'hunted'));
end $$;

-- Retour au salon pour rejouer (hôte uniquement)
create or replace function public.reset_game(
  p_code text, p_host_id text default null, p_secret text default ''
) returns void
language plpgsql security definer set search_path = public as $$
declare manual boolean;
begin
  if p_host_id is not null then
    perform public.assert_host(p_code, p_host_id, p_secret);
  end if;
  select (settings->>'roleMode') = 'manual' into manual from public.sessions where code = p_code;
  update public.players
     set role = case when manual then coalesce(initial_role, 'hunted') else 'hunted' end,
         caught_by = null, caught_at = null, circle = null, pos = null, seen = null
   where session_code = p_code;
  delete from public.events where session_code = p_code;
  update public.sessions set status = 'lobby', start_at = null, end_at = null, winner = null, ended_at = null
   where code = p_code;
end $$;

-- Nettoyage : supprime les sessions de plus de 2 jours
create or replace function public.cleanup_old_sessions() returns void
language sql security definer set search_path = public as $$
  delete from public.sessions where created_at < now() - interval '2 days';
$$;
