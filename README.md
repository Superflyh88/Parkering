# Telenorparkering

Booking av delt p-tillatelse. Samme app som før, men uten Claude under seg:
den kjører nå som en helt vanlig nettside med Supabase som database, og kan
ligge på din egen adresse.

Nytt i denne versjonen: kalenderen oppdaterer seg live. Booker en kollega en
dag, forsvinner plassen hos de andre uten at noen må laste siden på nytt.

---

## 1. Database (5 minutter)

1. Lag et gratis prosjekt på [supabase.com](https://supabase.com).
2. Åpne **SQL Editor**, lim inn hele `supabase.sql` og kjør den.
3. Gå til **Project settings → API** og kopier `Project URL` og `anon public`-nøkkelen.

## 2. Kjør lokalt

```bash
npm install
cp .env.example .env      # lim inn URL og anon-nøkkel
npm run dev
```

Åpne adressen Vite skriver ut. Mangler `.env`, starter appen i lokal modus:
den virker, men lagrer bare i din egen nettleser og varsler om det øverst.

## 3. Legg den ut

**Vercel** er enklest:

```bash
npx vercel
```

Legg inn `VITE_SUPABASE_URL` og `VITE_SUPABASE_ANON_KEY` under
Settings → Environment Variables, og deploy på nytt.

**Netlify eller Cloudflare Pages** går like fint: kjør `npm run build` og
dra `dist`-mappen inn i nettleseren deres, eller koble til et Git-repo med
byggkommando `npm run build` og publiseringsmappe `dist`.

## 4. Egen adresse

Uten eget domene får du noe i retning av `telenorparkering.vercel.app` — gratis
og fullt brukbart. Vil du ha `telenorparkering.no`, kjøper du domenet
(Domeneshop, Domene.no, ca. 100–200 kr året) og peker det mot Vercel under
Settings → Domains. Sertifikat kommer automatisk.

Kremt: navnet inneholder «Telenor». Ta en kort prat med IT eller nærmeste leder
før dere spres bredt — ikke fordi et bookingark for én p-plass er kontroversielt,
men fordi navnet får det til å se offisielt ut, og fordi appen lagrer skiltnumre.

---

## Hvordan den er satt sammen

```
src/App.jsx     hele appen: kalender, venteliste, admin, registrering
src/store.js    lagringslaget – Supabase, eller localStorage hvis nøkler mangler
supabase.sql    tabell, tilgangsregler og live-oppdatering
```

Hele kalenderen ligger som ett JSON-dokument i én rad i tabellen `app_state`.
Appen leser raden på nytt rett før hver endring og skriver den tilbake, så to
som booker samtidig går som regel bra. Det er likevel «siste skriving vinner»
— med en håndfull kollegaer merker dere det aldri, men skal dette vokse, bør
bookinger få hver sin rad.

## Det du bør vite før dere tar den i bruk

**Ingen innlogging.** Alle med lenken kan skrive inn hvilket navn som helst.
Det holder i en kollegagruppe, men admin-loggen viser hvem som *sa* de var det.

**Anon-nøkkelen er offentlig.** Den ligger i nettleserkoden, slik den skal, og
tilgangsreglene i `supabase.sql` åpner raden for alle som har den. Det er greit
for en delt p-plass, men det er ikke en sikkerhetsgrense.

**PIN-koden** til admin ligger som en enkel hash i samme rad. Den hindrer at
noen klikker seg inn ved et uhell. Den stopper ingen som virkelig vil inn.

**Skiltnumre er personopplysninger.** De vises bare for admin og personen selv,
men de ligger i databasen. Skal dette leve lenge og vokse, hører det hjemme bak
Entra ID på Telenors egen infrastruktur — da forsvinner både PIN-koden og det
tillitsbaserte navnefeltet, og personvernombudet har noe å forholde seg til.

## Veien videre, hvis det blir aktuelt

- **Ekte innlogging.** Supabase Auth med Azure/Entra som leverandør, begrenset
  til `@telenor.no`. Da forsvinner både navnefeltet og PIN-koden, og
  tilgangsreglene i SQL-en kan strammes til per bruker.
- **E-post som sender seg selv.** En Supabase Edge Function med Resend eller
  Postmark, så slipper kollegaene å trykke send på registreringen sin.
- **Kalenderfil.** En `.ics` per booking, så dagen havner i Outlook.
