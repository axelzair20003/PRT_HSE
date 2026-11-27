-- =====================================================================
-- PRT HSE — base de données Supabase
-- À coller dans Supabase → SQL Editor → New query → Run (une seule fois)
--
-- Règles :
--   • seules les adresses invitées (table invites) peuvent créer un compte
--   • un inspecteur ne voit que SES audits, actions et photos
--   • l'admin (admin HSE) voit et modifie tout, gère les invitations,
--     les projets, les entreprises et les plans
--   • chaque invitation porte des droits (créer des audits, voir le détail,
--     exporter, gérer les actions) et une liste de projets autorisés
--
-- Le script peut être relancé sans risque (mise à jour d'une base existante).
-- =====================================================================

-- ⚠️ AVANT d'exécuter : remplacer ADRESSE-EMAIL-ADMIN@exemple.com tout en bas
--    par l'adresse email de l'admin HSE (c'est lui qui sera administrateur)

-- ---------- Tables ----------
create table if not exists public.invites (
  email      text primary key check (email = lower(email)),
  name       text,
  role       text not null default 'inspector' check (role in ('admin', 'inspector')),
  created_at timestamptz not null default now()
);
alter table public.invites add column if not exists perms jsonb not null default '{"audit": true, "details": true, "export": true, "actions": true}';
alter table public.invites add column if not exists projects text[];   -- null = tous les projets
-- code d'invitation personnel (envoyé dans le lien) : sans lui, impossible de créer le compte à cette adresse
alter table public.invites add column if not exists code text default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null,
  name       text,
  role       text not null default 'inspector' check (role in ('admin', 'inspector')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists perms jsonb not null default '{"audit": true, "details": true, "export": true, "actions": true}';
alter table public.profiles add column if not exists projects text[];

-- Tous les enregistrements de l'app (même format que dans le téléphone)
create table if not exists public.docs (
  id         text primary key,
  kind       text not null,
  owner      uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);
alter table public.docs add column if not exists project text;
alter table public.docs drop constraint if exists docs_kind_check;
alter table public.docs add constraint docs_kind_check check (kind in ('inspection', 'action', 'sub', 'plan', 'project', 'summary'));
create index if not exists docs_updated_idx on public.docs (updated_at);
create index if not exists docs_owner_idx on public.docs (owner);

-- ---------- Fonctions de rôle (schéma privé, non exposé par l'API) ----------
create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated;

create or replace function app_private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- projet autorisé pour l'utilisateur connecté (liste vide/nulle = tous)
create or replace function app_private.can_project(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active
    and (role = 'admin' or projects is null or cardinality(projects) = 0 or p is null or p = any(projects)));
$$;

-- droit accordé par l'administrateur (les droits « aperçu équipe » et « actions des autres » sont décochés par défaut)
create or replace function app_private.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and coalesce((perms ->> p)::boolean, false));
$$;

create or replace function app_private.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

-- ---------- Inscription réservée aux invités ----------
create or replace function app_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv invites;
begin
  select * into inv from invites where email = lower(new.email);
  if not found then
    raise exception 'not invited';
  end if;
  if inv.code is not null and upper(coalesce(new.raw_user_meta_data ->> 'code', '')) <> upper(inv.code) then
    raise exception 'bad invite code';
  end if;
  insert into profiles (id, email, name, role, perms, projects)
  values (new.id, lower(new.email), coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), inv.name), inv.role, inv.perms, inv.projects);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ---------- Sécurité (Row Level Security) ----------
alter table public.invites  enable row level security;
alter table public.profiles enable row level security;
alter table public.docs     enable row level security;

drop policy if exists "invites: admin" on public.invites;
create policy "invites: admin" on public.invites
  for all to authenticated using ((select app_private.is_admin())) with check ((select app_private.is_admin()));

drop policy if exists "profiles: lecture" on public.profiles;
create policy "profiles: lecture" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select app_private.is_admin()));

drop policy if exists "profiles: admin modifie" on public.profiles;
create policy "profiles: admin modifie" on public.profiles
  for update to authenticated using ((select app_private.is_admin())) with check ((select app_private.is_admin()));

drop policy if exists "docs: lecture" on public.docs;
create policy "docs: lecture" on public.docs
  for select to authenticated using (
    (select app_private.is_active()) and (
      kind = 'sub' or owner = (select auth.uid()) or (select app_private.is_admin())
      or (kind in ('plan', 'project') and app_private.can_project(project))
      or (kind = 'summary' and (select app_private.has_perm('team')) and app_private.can_project(project))
      or (kind = 'action' and (select app_private.has_perm('teamActions')) and app_private.can_project(project))
    )
  );

drop policy if exists "docs: création" on public.docs;
create policy "docs: création" on public.docs
  for insert to authenticated with check (
    (select app_private.is_active()) and ((kind in ('inspection', 'action', 'summary') and owner = (select auth.uid()) and app_private.can_project(project)) or (select app_private.is_admin()))
  );

drop policy if exists "docs: modification" on public.docs;
create policy "docs: modification" on public.docs
  for update to authenticated
  using ((select app_private.is_active()) and ((kind in ('inspection', 'action', 'summary') and owner = (select auth.uid())) or (select app_private.is_admin())))
  with check ((select app_private.is_active()) and ((kind in ('inspection', 'action', 'summary') and owner = (select auth.uid()) and app_private.can_project(project)) or (select app_private.is_admin())));
-- pas de suppression physique : l'app marque deleted = true

-- ---------- Stockage des fichiers ----------
-- photos : dossier par utilisateur ;  shared : plans et logos (lisibles par tous les comptes actifs)
insert into storage.buckets (id, name, public) values ('photos', 'photos', false), ('shared', 'shared', false)
on conflict (id) do nothing;

drop policy if exists "photos: lecture" on storage.objects;
create policy "photos: lecture" on storage.objects for select
  using (bucket_id = 'photos' and (app_private.is_admin() or (storage.foldername(name))[1] = auth.uid()::text));

drop policy if exists "photos: envoi" on storage.objects;
create policy "photos: envoi" on storage.objects for insert
  with check (bucket_id = 'photos' and app_private.is_active() and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin()));

-- photos des actions encore ouvertes des autres HSE (droit « Actions des autres »)
drop policy if exists "photos: actions des autres" on storage.objects;
create policy "photos: actions des autres" on storage.objects for select
  using (bucket_id = 'photos' and app_private.is_active() and app_private.has_perm('teamActions') and exists (
    select 1 from public.docs d
    where d.kind = 'action' and not d.deleted and app_private.can_project(d.project)
      and d.owner::text = (storage.foldername(name))[1]
      and (d.data -> 'photos') ? storage.filename(name)));

-- suppression : chacun ses photos (l'admin toutes), pour ne pas payer le stockage de photos effacées
drop policy if exists "photos: suppression" on storage.objects;
create policy "photos: suppression" on storage.objects for delete
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin()));

drop policy if exists "photos: remplacement" on storage.objects;
create policy "photos: remplacement" on storage.objects for update
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin()));

drop policy if exists "shared: lecture" on storage.objects;
create policy "shared: lecture" on storage.objects for select
  using (bucket_id = 'shared' and app_private.is_active());

drop policy if exists "shared: admin envoi" on storage.objects;
create policy "shared: admin envoi" on storage.objects for insert
  with check (bucket_id = 'shared' and app_private.is_admin());

drop policy if exists "shared: admin remplacement" on storage.objects;
create policy "shared: admin remplacement" on storage.objects for update
  using (bucket_id = 'shared' and app_private.is_admin());

-- ---------- Date d'envoi fixée par le serveur ----------
-- (un audit fait hors ligne puis envoyé plus tard doit quand même arriver chez les autres)
create or replace function app_private.set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists docs_updated_at on public.docs;
create trigger docs_updated_at before insert or update on public.docs
  for each row execute function app_private.set_updated_at();

-- ---------- Droits d'accès à l'API (en plus des règles RLS) ----------
revoke all on public.invites, public.profiles, public.docs from anon, authenticated;
grant select, insert, update, delete on public.invites to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.docs to authenticated;
revoke execute on function app_private.handle_new_user() from public, anon, authenticated;
revoke execute on function app_private.set_updated_at() from public, anon, authenticated;
revoke execute on function app_private.is_admin(), app_private.can_project(text), app_private.has_perm(text), app_private.is_active() from public, anon;
grant execute on function app_private.is_admin(), app_private.can_project(text), app_private.has_perm(text), app_private.is_active() to authenticated;

-- ---------- Mot de passe oublié : l'admin donne un mot de passe provisoire (pas besoin d'email) ----------
create or replace function app_private.set_password(target uuid, new_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'réservé à l''administrateur'; end if;
  if length(coalesce(new_password, '')) < 8 then raise exception 'mot de passe trop court'; end if;
  if exists (select 1 from public.profiles where id = target and role = 'admin') then
    raise exception 'compte administrateur : à réinitialiser depuis Supabase';
  end if;
  update auth.users set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')), updated_at = now()
  where id = target;
  if not found then raise exception 'compte introuvable'; end if;
end;
$$;
revoke execute on function app_private.set_password(uuid, text) from public, anon;
grant execute on function app_private.set_password(uuid, text) to authenticated;

create or replace function public.admin_set_password(target uuid, new_password text) returns void
language sql security invoker set search_path = '' as $$
  select app_private.set_password(target, new_password);
$$;
revoke execute on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

-- ---------- Premier administrateur ----------
-- L'admin reçoit lui aussi un code personnel : personne d'autre ne peut créer son compte à sa place.
-- Après ce script : select code from invites where email = '...';  puis lui envoyer le lien #/join?e=…&c=CODE
insert into public.invites (email, name, role)
values (lower('ADRESSE-EMAIL-ADMIN@exemple.com'), 'Admin HSE', 'admin')   -- ⚠️ à remplacer
on conflict (email) do update set role = 'admin';
