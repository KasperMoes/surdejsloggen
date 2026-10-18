-- Surdejsloggen – database til brugere, venner og bagninger.
-- Køres én gang i Supabase: SQL Editor → New query → indsæt alt → Run.

-- ---------- profiler ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,24}$'),
  display_name text not null default '',
  created_at timestamptz not null default now()
);

-- Opret profil automatisk, når en bruger tilmelder sig (brugernavn sendes med ved tilmelding).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data->>'username', 'bager' || substr(new.id::text, 1, 8))),
    coalesce(new.raw_user_meta_data->>'display_name', '')
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Tjek om et brugernavn er ledigt, før man tilmelder sig (virker også uden login).
create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- venner ----------
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

-- ---------- bagninger ----------
create table if not exists public.bakes (
  id text primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  date date not null,
  name text not null default '',
  kind text not null default 'bread',
  overall int not null default 0,
  caption text not null default '',
  pics text[] not null default '{}',
  data jsonb not null default '{}'::jsonb,   -- mel, vand, tider, ovn, delbedømmelser, noter
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bakes_user_date on public.bakes (user_id, date desc);

-- ---------- adgangsregler ----------
alter table public.profiles   enable row level security;
alter table public.friendships enable row level security;
alter table public.bakes      enable row level security;

-- Profiler: alle indloggede kan finde hinanden (til vennesøgning); man retter kun sin egen.
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Venskaber: man ser sine egne; sender anmodninger i eget navn; kun modtageren kan godkende; begge kan fjerne.
drop policy if exists "friends read" on public.friendships;
create policy "friends read" on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());
drop policy if exists "friends request" on public.friendships;
create policy "friends request" on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');
drop policy if exists "friends accept" on public.friendships;
create policy "friends accept" on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
drop policy if exists "friends remove" on public.friendships;
create policy "friends remove" on public.friendships for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- Bagninger: egne + venners kan ses; kun egne kan oprettes, rettes og slettes.
drop policy if exists "bakes read" on public.bakes;
create policy "bakes read" on public.bakes for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
drop policy if exists "bakes insert" on public.bakes;
create policy "bakes insert" on public.bakes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "bakes update" on public.bakes;
create policy "bakes update" on public.bakes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "bakes delete" on public.bakes;
create policy "bakes delete" on public.bakes for delete to authenticated using (user_id = auth.uid());

-- ---------- billeder ----------
-- Privat bucket; hver bruger har sin egen mappe <bruger-id>/...; venner kan se billederne.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists "photos read" on storage.objects;
create policy "photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.are_friends(auth.uid(), ((storage.foldername(name))[1])::uuid)
  ));
drop policy if exists "photos upload" on storage.objects;
create policy "photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "photos delete" on storage.objects;
create policy "photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- strammere adgang til hjælpefunktioner ----------
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select a = auth.uid() and exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- Kun status må ændres på et venskab, og kun visningsnavn på en profil.
revoke update on public.friendships from authenticated, anon;
grant update (status) on public.friendships to authenticated;
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

-- ---------- profilbilleder og push-beskeder ----------
-- (oprettet direkte i Supabase; se migrationen "avatars_and_push").
-- Hemmelige nøgler (VAPID og hook-secret) ligger i Supabase Vault og er ikke i denne fil.
-- Edge function "push" sender beskederne: supabase/functions/push/index.ts

-- ---------- kommentarer ----------
-- Tabel public.comments (migration "comments"): man kan læse og skrive kommentarer på
-- bagninger, man må se; man kan slette sine egne og alle kommentarer på sine egne bagninger.
-- Trigger push_on_comment giver ejeren af bagningen en push-besked.

-- ---------- sprødt! (likes) ----------
-- Tabeller public.bake_likes og public.comment_likes (migration "sprodt_likes").
-- Trigger push_on_bake_like giver ejeren af bagningen en push-besked.

-- ---------- ret kommentarer ----------
-- Migration "comments_edit": kolonnen edited_at; man må kun rette body på sine egne
-- kommentarer; trigger comments_edited sætter edited_at.

-- ---------- tags (@brugernavn) ----------
-- Migration "mentions_push": triggers push_on_bake_tag og push_on_comment_tag, når en tekst
-- med @ bliver rettet. Edge function "push" finder nye @brugernavne og sender kun til folk,
-- der må se bagningen (ejeren og ejerens venner).

-- ---------- brugernavne med æ, ø og å ----------
-- Migration "username_aeoeaa": profiles_username_check er nu '^[a-z0-9_.æøå]{3,24}$'.

-- ---------- skift brugernavn ----------
-- Migrationer "change_username" + "change_username_lookahead": grant update(username) på profiles;
-- trigger profiles_rename_mentions retter gamle @tags i bakes.caption og comments.body.
-- Under omdøbning (app.renaming = '1') sendes ingen push, og kommentarer markeres ikke som redigeret.
