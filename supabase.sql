-- Kjør dette én gang i Supabase → SQL Editor.
-- Hele kalenderen ligger som ett JSON-dokument i én rad. Det er nok for
-- en gruppe kollegaer, og gjør at appen kan lese og skrive alt i én
-- operasjon. Skal dere over noen titalls brukere, bør bookinger få
-- egen tabell med rader — da forsvinner faren for at to som lagrer
-- samtidig overskriver hverandre.

create table if not exists public.app_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- Merk: dette gir alle med nettadressen og anon-nøkkelen full tilgang
-- til å lese og skrive raden. Det er samme tillitsnivå som appen hadde
-- fra før, og greit for en liten kollegagruppe – men det er ikke
-- sikkerhet. Skal skiltnumre ligge her over tid, bør dere over på
-- ekte innlogging (se README).
drop policy if exists "les app_state" on public.app_state;
create policy "les app_state" on public.app_state
  for select using (true);

drop policy if exists "opprett app_state" on public.app_state;
create policy "opprett app_state" on public.app_state
  for insert with check (true);

drop policy if exists "oppdater app_state" on public.app_state;
create policy "oppdater app_state" on public.app_state
  for update using (true);

-- Live-oppdatering: kalenderen endrer seg hos alle når én booker.
alter publication supabase_realtime add table public.app_state;

-- Startrad. Appen fyller den ut selv ved første bruk, men da slipper
-- dere en tom skjerm det første sekundet.
insert into public.app_state (id, data)
values ('fornebu', '{}'::jsonb)
on conflict (id) do nothing;
