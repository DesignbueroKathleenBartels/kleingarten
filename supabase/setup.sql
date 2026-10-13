-- Kleingarten: einmalig im Supabase SQL Editor ausführen.

-- 1) Eine Tabelle für alle Einträge (Pflanzen, Aufgaben, Pflege, Fotos-Infos)
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- 2) Zugriffsregeln: alle mit dem Link dürfen ansehen, nur angemeldete Personen dürfen ändern
alter table public.docs enable row level security;
drop policy if exists "docs lesen"   on public.docs;
drop policy if exists "docs anlegen" on public.docs;
drop policy if exists "docs ändern"  on public.docs;
drop policy if exists "docs löschen" on public.docs;
create policy "docs lesen"   on public.docs for select to anon, authenticated using (true);
create policy "docs anlegen" on public.docs for insert to authenticated with check (true);
create policy "docs ändern"  on public.docs for update to authenticated using (true) with check (true);
create policy "docs löschen" on public.docs for delete to authenticated using (true);

-- 3) Live-Abgleich zwischen den Handys
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 4) Fotospeicher (öffentlich lesbar, nur Angemeldete laden hoch oder löschen)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 10485760, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = true;

drop policy if exists "fotos hochladen" on storage.objects;
drop policy if exists "fotos ändern"    on storage.objects;
drop policy if exists "fotos löschen"   on storage.objects;
drop policy if exists "fotos auflisten" on storage.objects;
create policy "fotos hochladen" on storage.objects for insert to authenticated with check (bucket_id = 'fotos');
create policy "fotos ändern"    on storage.objects for update to authenticated using (bucket_id = 'fotos');
create policy "fotos löschen"   on storage.objects for delete to authenticated using (bucket_id = 'fotos');
create policy "fotos auflisten" on storage.objects for select to authenticated using (bucket_id = 'fotos');
