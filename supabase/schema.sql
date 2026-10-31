-- =====================================================================
-- Tracker Man – schéma Supabase
-- À exécuter une seule fois dans : Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- Tables ----------
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
  catch_code   text not null,
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
  type         text not null, -- 'start' | 'caught' | 'out_of_zone' | 'pos'
  t            bigint not null,
  data         jsonb not null default '{}'::jsonb
);
create index if not exists events_session_idx on public.events(session_code);

-- ---------- Sécurité (jeu entre amis : accès public via la clé anon) ----------
alter table public.sessions enable row level security;
alter table public.players  enable row level security;
alter table public.events   enable row level security;

drop policy if exists "public access" on public.sessions;
drop policy if exists "public access" on public.players;
drop policy if exists "public access" on public.events;
create policy "public access" on public.sessions for all to anon, authenticated using (true) with check (true);
create policy "public access" on public.players  for all to anon, authenticated using (true) with check (true);
create policy "public access" on public.events   for all to anon, authenticated using (true) with check (true);

-- ---------- Temps réel ----------
do $$
begin
  begin alter publication supabase_realtime add table public.sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.players;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.events;   exception when duplicate_object then null; end;
end $$;

-- ---------- Fonctions ----------
create or replace function public.now_ms() returns bigint
language sql volatile as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- Heure serveur (synchronisation des chronos)
create or replace function public.server_now() returns bigint
language sql volatile as $$ select public.now_ms() $$;

-- Rejoindre une session
create or replace function public.join_session(p_code text, p_id text, p_name text) returns void
language plpgsql as $$
declare s record;
begin
  select * into s from public.sessions where code = p_code;
  if not found then raise exception 'Session introuvable'; end if;
  if exists (select 1 from public.players where session_code = p_code and id = p_id) then
    update public.players set name = p_name where session_code = p_code and id = p_id;
    return;
  end if;
  if s.status <> 'lobby' then raise exception 'La partie a déjà commencé'; end if;
  insert into public.players(session_code, id, name, catch_code, joined_at)
  values (p_code, p_id, p_name, lpad(floor(random() * 10000)::int::text, 4, '0'), public.now_ms());
end $$;

-- Quitter une session (transfère l'hôte ou supprime la session si vide)
create or replace function public.leave_session(p_code text, p_id text) returns void
language plpgsql as $$
declare s record; next_host text;
begin
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

-- Lancer la partie
create or replace function public.start_game(p_code text, p_hunters text[]) returns void
language plpgsql as $$
declare st jsonb; t bigint := public.now_ms(); pl record; used text[] := '{}'; c text; r text;
begin
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
       set role = r, initial_role = r, catch_code = c,
           caught_by = null, caught_at = null, circle = null, pos = null, seen = null
     where session_code = p_code and id = pl.id;
  end loop;
  delete from public.events where session_code = p_code;
  update public.sessions
     set status = 'playing', start_at = t, end_at = t + (st->>'total')::bigint * 60000,
         winner = null, ended_at = null
   where code = p_code;
  insert into public.events(session_code, type, t) values (p_code, 'start', t);
end $$;

-- Un chassé se déclare attrapé avec le code du chasseur
create or replace function public.catch_player(p_code text, p_victim text, p_catch_code text) returns text
language plpgsql as $$
declare v record; h record; t bigint := public.now_ms();
begin
  if not exists (select 1 from public.sessions where code = p_code and status = 'playing') then
    raise exception 'La partie n''est pas en cours';
  end if;
  select * into v from public.players where session_code = p_code and id = p_victim for update;
  if not found or v.role <> 'hunted' then raise exception 'Tu n''es pas chassé'; end if;
  select * into h from public.players
   where session_code = p_code and role = 'hunter' and catch_code = p_catch_code and id <> p_victim limit 1;
  if not found then raise exception 'Code chasseur invalide'; end if;
  update public.players set role = 'hunter', caught_by = h.id, caught_at = t, circle = null
   where session_code = p_code and id = p_victim;
  insert into public.events(session_code, type, t, data)
  values (p_code, 'caught', t, jsonb_build_object('victim', v.id, 'victimName', v.name, 'hunter', h.id, 'hunterName', h.name));
  return h.name;
end $$;

-- Termine la partie si le temps est écoulé ou s'il ne reste plus de chassés (vérifié côté serveur)
create or replace function public.end_game(p_code text) returns void
language plpgsql as $$
declare t bigint := public.now_ms();
begin
  update public.sessions
     set status = 'ended', ended_at = t,
         winner = case when t >= end_at then 'hunted' else 'hunters' end
   where code = p_code and status = 'playing'
     and (t >= end_at or not exists (select 1 from public.players where session_code = p_code and role = 'hunted'));
end $$;

-- Retour au salon pour rejouer
create or replace function public.reset_game(p_code text) returns void
language plpgsql as $$
declare manual boolean;
begin
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
language sql as $$ delete from public.sessions where created_at < now() - interval '2 days' $$;
