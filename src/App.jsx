import { useEffect, useMemo, useState } from "react";
import { storage, mode as storeMode } from "./store.js";

/* ------------------------------------------------------------------ */
/*  Lagring                                                            */
/* ------------------------------------------------------------------ */

const SHARED_KEY = "parking:state:v1";
const ME_KEY = "parking:me:v1";
const ADMIN_KEY = "parking:admin:v1";

const uid = () => Math.random().toString(36).slice(2, 10);

// Enkel hash. Dette er en lås på døren, ikke en safe – nok til å hindre
// at kollegaer klikker seg inn ved et uhell.
function hashPin(pin) {
  let h = 5381;
  const s = `p-tillatelse:${pin}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const defaultState = () => ({
  v: 3,
  permits: [{ id: uid(), label: "P1", note: "Telenor Fornebu" }],
  bookings: [],
  waitlist: [],
  blocks: [],
  people: [],
  log: [],
  admin: { pinHash: null, setBy: null },
  settings: { horizonDays: 30, onePerDay: true, adminEmail: "mahyar.harirchi@telenor.no" },
});

const normPlate = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9ÆØÅ]/g, "");
const plateLooksOk = (s) => /^[A-Z0-9ÆØÅ]{2,7}$/.test(normPlate(s));

function mailto(to, subject, body) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function pushLog(s, actor, text) {
  s.log = [{ id: uid(), ts: Date.now(), actor, text }, ...(s.log || [])].slice(0, 150);
  return s;
}

function normalize(s) {
  const base = defaultState();
  const out = {
    v: 3,
    permits: Array.isArray(s?.permits) ? s.permits : base.permits,
    bookings: Array.isArray(s?.bookings) ? s.bookings : [],
    waitlist: Array.isArray(s?.waitlist) ? s.waitlist : [],
    blocks: Array.isArray(s?.blocks) ? s.blocks : [],
    people: Array.isArray(s?.people) ? s.people : [],
    log: Array.isArray(s?.log) ? s.log : [],
    admin: { ...base.admin, ...(s?.admin || {}) },
    settings: { ...base.settings, ...(s?.settings || {}) },
  };
  // Rydd bort alt eldre enn 120 dager så lagringen holder seg liten
  const cutoff = toISO(addDays(new Date(), -120));
  out.bookings = out.bookings.filter((b) => b.date >= cutoff);
  out.blocks = out.blocks.filter((b) => b.date >= cutoff);
  out.waitlist = out.waitlist.filter((w) => w.date >= toISO(new Date()));
  out.log = out.log.slice(0, 150);
  return out;
}

async function loadShared() {
  try {
    const r = await storage.get(SHARED_KEY, true);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Dato                                                               */
/* ------------------------------------------------------------------ */

const DAYS = ["Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];
const DAYS_SHORT = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fromISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function isoWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + 3 - ((x.getDay() + 6) % 7));
  const first = new Date(x.getFullYear(), 0, 4);
  return 1 + Math.round(((x - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}
const dayIdx = (iso) => (fromISO(iso).getDay() + 6) % 7;
const isWeekend = (iso) => dayIdx(iso) >= 5;

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [me, setMe] = useState(null);
  const [myPlate, setMyPlate] = useState("");
  const [mailPrompt, setMailPrompt] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [showWeekend, setShowWeekend] = useState(false);
  const [panel, setPanel] = useState(null); // 'permits' | 'fordeling' | 'om' | 'admin' | 'meg'
  const [isAdmin, setIsAdmin] = useState(false);
  const [assignTo, setAssignTo] = useState(null); // {date, permitId}
  const [blockFor, setBlockFor] = useState(null); // {date, permitId}

  const today = toISO(new Date());

  useEffect(() => {
    let alive = true;
    (async () => {
      let name = null;
      let plate = "";
      try {
        const r = await storage.get(ME_KEY, false);
        if (r) {
          const p = JSON.parse(r.value);
          name = p.name || null;
          plate = p.plate || "";
        }
      } catch {
        name = null;
      }
      const shared = await loadShared();
      let admin = false;
      try {
        const a = await storage.get(ADMIN_KEY, false);
        admin = a ? !!JSON.parse(a.value).unlocked : false;
      } catch {
        admin = false;
      }
      if (!alive) return;
      setMe(name);
      setMyPlate(plate);
      setIsAdmin(admin && !!normalize(shared || {}).admin.pinHash);
      setState(normalize(shared || defaultState()));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const off = storage.subscribe((remote) => {
      setState(normalize(remote));
    });
    return off;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  async function refresh() {
    const shared = await loadShared();
    if (shared) setState(normalize(shared));
  }

  async function mutate(fn) {
    setBusy(true);
    try {
      const current = normalize((await loadShared()) || state || defaultState());
      const next = fn(structuredClone(current));
      if (!next) {
        setState(current);
        setBusy(false);
        return;
      }
      await storage.set(SHARED_KEY, JSON.stringify(next), true);
      setState(next);
      setError(null);
    } catch {
      setError("Endringen ble ikke lagret. Sjekk nettet og prøv igjen.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(name, plate) {
    const clean = name.trim().replace(/\s+/g, " ");
    const pl = normPlate(plate);
    if (!clean || !pl) return;
    const old = me;
    setMe(clean);
    setMyPlate(pl);
    try {
      await storage.set(ME_KEY, JSON.stringify({ name: clean, plate: pl }), false);
    } catch {
      /* profilen lever videre i økten */
    }
    await mutate((s) => {
      if (old && old !== clean) {
        s.bookings = s.bookings.map((b) => (b.user === old ? { ...b, user: clean } : b));
        s.waitlist = s.waitlist.map((w) => (w.user === old ? { ...w, user: clean } : w));
        s.people = s.people.map((p) => (p.name === old ? { ...p, name: clean } : p));
      }
      const existing = s.people.find((p) => p.name === clean);
      if (existing) {
        if (existing.plate !== pl) {
          existing.plate = pl;
          existing.approved = false;
          existing.ts = Date.now();
          pushLog(s, clean, `endret skilt til ${pl}`);
        }
      } else {
        s.people.push({ id: uid(), name: clean, plate: pl, approved: false, ts: Date.now() });
        pushLog(s, clean, `registrerte seg med ${pl}`);
      }
      return s;
    });
    setMailPrompt({ name: clean, plate: pl });
  }

  /* --------------------------- handlinger --------------------------- */

  const book = (date, permitId) =>
    mutate((s) => {
      if (s.bookings.some((b) => b.date === date && b.permitId === permitId)) {
        setToast("Plassen ble tatt av en annen for et øyeblikk siden.");
        return s;
      }
      if (s.settings.onePerDay && s.bookings.some((b) => b.date === date && b.user === me)) {
        setToast("Du har allerede en plass denne dagen.");
        return s;
      }
      s.bookings.push({ id: uid(), date, permitId, user: me, ts: Date.now() });
      s.waitlist = s.waitlist.filter((w) => !(w.date === date && w.user === me));
      const pl = s.permits.find((x) => x.id === permitId);
      return pushLog(s, me, `booket ${date} (${pl ? pl.label : "?"})`);
    });

  const release = (bookingId) =>
    mutate((s) => {
      const b = s.bookings.find((x) => x.id === bookingId);
      if (!b) return s;
      s.bookings = s.bookings.filter((x) => x.id !== bookingId);
      const next = s.waitlist.filter((w) => w.date === b.date).sort((a, c) => a.ts - c.ts)[0];
      if (next) {
        s.waitlist = s.waitlist.filter((w) => w.id !== next.id);
        s.bookings.push({ id: uid(), date: b.date, permitId: b.permitId, user: next.user, ts: Date.now(), fromWaitlist: true });
        setToast(`Plassen gikk videre til ${next.user} fra ventelisten.`);
        pushLog(s, me, `frigjorde ${b.date} → ${next.user} fra venteliste`);
      } else {
        setToast("Plassen er frigitt.");
        pushLog(s, me, `frigjorde ${b.date}`);
      }
      return s;
    });

  const joinWaitlist = (date) =>
    mutate((s) => {
      if (s.waitlist.some((w) => w.date === date && w.user === me)) return s;
      s.waitlist.push({ id: uid(), date, user: me, ts: Date.now() });
      setToast("Du står på ventelisten. Du får plassen automatisk hvis noen frigir den.");
      return s;
    });

  const leaveWaitlist = (date) =>
    mutate((s) => {
      s.waitlist = s.waitlist.filter((w) => !(w.date === date && w.user === me));
      return s;
    });

  const addPermit = (label, note) =>
    mutate((s) => {
      s.permits.push({ id: uid(), label: label.trim() || `P${s.permits.length + 1}`, note: note.trim() });
      return s;
    });

  const updatePermit = (id, patch) =>
    mutate((s) => {
      s.permits = s.permits.map((p) => (p.id === id ? { ...p, ...patch } : p));
      return s;
    });

  const removePermit = (id) =>
    mutate((s) => {
      s.permits = s.permits.filter((p) => p.id !== id);
      s.bookings = s.bookings.filter((b) => b.permitId !== id);
      return s;
    });

  const setSetting = (patch) =>
    mutate((s) => {
      s.settings = { ...s.settings, ...patch };
      return pushLog(s, me, `endret regler`);
    });

  /* ------------------------------ admin ----------------------------- */

  async function rememberAdmin(unlocked) {
    setIsAdmin(unlocked);
    try {
      await storage.set(ADMIN_KEY, JSON.stringify({ unlocked }), false);
    } catch {
      /* økten lever videre uansett */
    }
  }

  async function unlockAdmin(pin) {
    const current = normalize((await loadShared()) || state);
    if (!current.admin.pinHash) {
      await mutate((s) => {
        s.admin = { pinHash: hashPin(pin), setBy: me };
        return pushLog(s, me, "opprettet admin-PIN");
      });
      await rememberAdmin(true);
      setToast("Admin er satt opp. Ta vare på PIN-koden.");
      return true;
    }
    if (hashPin(pin) === current.admin.pinHash) {
      await rememberAdmin(true);
      setToast("Admin er låst opp.");
      return true;
    }
    setToast("Feil PIN.");
    return false;
  }

  const changePin = (pin) =>
    mutate((s) => {
      s.admin = { pinHash: hashPin(pin), setBy: me };
      setToast("PIN-koden er endret.");
      return pushLog(s, me, "endret admin-PIN");
    });

  const assign = (date, permitId, user) =>
    mutate((s) => {
      const clean = user.trim().replace(/\s+/g, " ");
      if (!clean) return s;
      if (s.bookings.some((b) => b.date === date && b.permitId === permitId)) {
        setToast("Plassen er allerede tatt den dagen.");
        return s;
      }
      s.bookings.push({ id: uid(), date, permitId, user: clean, ts: Date.now(), byAdmin: me });
      s.waitlist = s.waitlist.filter((w) => !(w.date === date && w.user === clean));
      const pl = s.permits.find((x) => x.id === permitId);
      setToast(`${clean} har fått ${date}.`);
      return pushLog(s, me, `tildelte ${date} (${pl ? pl.label : "?"}) til ${clean}`);
    });

  const adminRemove = (bookingId, keepFree) =>
    mutate((s) => {
      const b = s.bookings.find((x) => x.id === bookingId);
      if (!b) return s;
      s.bookings = s.bookings.filter((x) => x.id !== bookingId);
      const next = keepFree ? null : s.waitlist.filter((w) => w.date === b.date).sort((a, c) => a.ts - c.ts)[0];
      if (next) {
        s.waitlist = s.waitlist.filter((w) => w.id !== next.id);
        s.bookings.push({ id: uid(), date: b.date, permitId: b.permitId, user: next.user, ts: Date.now(), fromWaitlist: true });
        setToast(`Plassen gikk videre til ${next.user}.`);
      } else {
        setToast(`Bookingen til ${b.user} er fjernet.`);
      }
      return pushLog(s, me, `fjernet bookingen til ${b.user} den ${b.date}`);
    });

  const blockBay = (date, permitId, reason) =>
    mutate((s) => {
      if (s.blocks.some((x) => x.date === date && x.permitId === permitId)) return s;
      s.blocks.push({ id: uid(), date, permitId, reason: reason.trim(), by: me, ts: Date.now() });
      const pl = s.permits.find((x) => x.id === permitId);
      setToast("Plassen er sperret.");
      return pushLog(s, me, `sperret ${date} (${pl ? pl.label : "?"})${reason.trim() ? `: ${reason.trim()}` : ""}`);
    });

  const unblockBay = (blockId) =>
    mutate((s) => {
      const b = s.blocks.find((x) => x.id === blockId);
      s.blocks = s.blocks.filter((x) => x.id !== blockId);
      return b ? pushLog(s, me, `åpnet ${b.date} igjen`) : s;
    });

  const dropWaitlist = (id) =>
    mutate((s) => {
      const w = s.waitlist.find((x) => x.id === id);
      s.waitlist = s.waitlist.filter((x) => x.id !== id);
      return w ? pushLog(s, me, `fjernet ${w.user} fra ventelisten ${w.date}`) : s;
    });

  const promoteWaitlist = (id) =>
    mutate((s) => {
      const w = s.waitlist.find((x) => x.id === id);
      if (!w) return s;
      const free = s.permits.find(
        (p) => !s.bookings.some((b) => b.date === w.date && b.permitId === p.id) && !s.blocks.some((x) => x.date === w.date && x.permitId === p.id)
      );
      if (!free) {
        setToast("Ingen ledig plass den dagen. Fjern en booking først.");
        return s;
      }
      s.waitlist = s.waitlist.filter((x) => x.id !== id);
      s.bookings.push({ id: uid(), date: w.date, permitId: free.id, user: w.user, ts: Date.now(), byAdmin: me });
      setToast(`${w.user} har fått plass ${w.date}.`);
      return pushLog(s, me, `ga ${w.user} plass ${w.date} fra ventelisten`);
    });

  const setApproved = (personId, approved) =>
    mutate((s) => {
      const p = s.people.find((x) => x.id === personId);
      if (!p) return s;
      p.approved = approved;
      p.approvedTs = approved ? Date.now() : null;
      return pushLog(s, me, `${approved ? "godkjente" : "avmerket"} ${p.plate} i Autopay`);
    });

  const removePerson = (personId) =>
    mutate((s) => {
      const p = s.people.find((x) => x.id === personId);
      s.people = s.people.filter((x) => x.id !== personId);
      return p ? pushLog(s, me, `fjernet ${p.name} (${p.plate})`) : s;
    });

  const clearFuture = () =>
    mutate((s) => {
      const t = toISO(new Date());
      const n = s.bookings.filter((b) => b.date >= t).length;
      s.bookings = s.bookings.filter((b) => b.date < t);
      s.waitlist = [];
      setToast(`${n} kommende bookinger er slettet.`);
      return pushLog(s, me, `slettet alle kommende bookinger (${n})`);
    });

  /* ----------------------------- avledet ---------------------------- */

  const week = useMemo(() => {
    const all = Array.from({ length: 7 }, (_, i) => toISO(addDays(anchor, i)));
    return showWeekend ? all : all.filter((d) => !isWeekend(d));
  }, [anchor, showWeekend]);

  const horizon = state ? toISO(addDays(new Date(), state.settings.horizonDays)) : today;

  const myUpcoming = useMemo(() => {
    if (!state || !me) return [];
    return state.bookings
      .filter((b) => b.user === me && b.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [state, me, today]);

  const myPerson = useMemo(() => (state && me ? state.people.find((p) => p.name === me) : null), [state, me]);

  const knownNames = useMemo(() => {
    if (!state) return [];
    const set = new Set([...state.bookings.map((b) => b.user), ...state.waitlist.map((w) => w.user)]);
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "nb"));
  }, [state]);

  if (loading) return <Shell><div className="skeleton" /></Shell>;
  if (!me) {
    return (
      <Shell>
        <Register onSave={saveProfile} />
        {mailPrompt && (
          <Sheet title="Siste steg" onClose={() => setMailPrompt(null)}>
            <MailPrompt info={mailPrompt} email={state.settings.adminEmail} onDone={() => setMailPrompt(null)} />
          </Sheet>
        )}
      </Shell>
    );
  }

  const permits = state.permits;

  return (
    <Shell>
      <header className="top">
        <div className="brand">
          <span className="eyebrow">Delt p-tillatelse</span>
          <h1>Fornebu</h1>
        </div>
        <div className="top-actions">
          <button className="chip" onClick={() => setPanel("fordeling")}>Fordeling</button>
          <button className="chip" onClick={() => setPanel("permits")}>Tillatelser</button>
          <button className={`chip${isAdmin ? " admin-on" : ""}`} onClick={() => setPanel("admin")}>
            {isAdmin ? "Admin på" : "Admin"}
          </button>
          <button className="chip who" onClick={() => setPanel("meg")} title="Bytt navn">
            <span className="dot" />{me}
          </button>
        </div>
      </header>

      {error && (
        <div className="banner">
          {error}
          <button className="link" onClick={refresh}>Hent på nytt</button>
        </div>
      )}

      {storeMode === "local" && (
        <div className="banner">
          Appen kjører uten delt database. Alt du legger inn blir liggende i denne nettleseren og deles ikke med andre — sett VITE_SUPABASE_URL og VITE_SUPABASE_ANON_KEY for å koble den på.
        </div>
      )}

      {myPerson && !myPerson.approved && (
        <div className="banner pending">
          Bilen din ({myPerson.plate}) er ikke bekreftet i Autopay ennå. Book gjerne, men vent med å parkere til den er godkjent.
          <button className="link" onClick={() => setMailPrompt({ name: me, plate: myPerson.plate })}>Send på nytt</button>
        </div>
      )}

      {myUpcoming.length > 0 && (
        <div className="mine">
          <span className="mine-label">Dine dager</span>
          <div className="mine-list">
            {myUpcoming.slice(0, 6).map((b) => {
              const p = permits.find((x) => x.id === b.permitId);
              return (
                <span key={b.id} className="mine-tag">
                  {DAYS_SHORT[dayIdx(b.date)]} {fromISO(b.date).getDate()}.{fromISO(b.date).getMonth() + 1}
                  <em>{p ? p.label : "—"}</em>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <nav className="weeknav">
        <button className="nav" onClick={() => setAnchor(addDays(anchor, -7))} aria-label="Forrige uke">←</button>
        <div className="weeklabel">
          <strong>Uke {isoWeek(anchor)}</strong>
          <span>{fromISO(toISO(anchor)).getDate()}.–{addDays(anchor, 6).getDate()}. {MONTHS[addDays(anchor, 6).getMonth()]}</span>
        </div>
        <button className="nav" onClick={() => setAnchor(addDays(anchor, 7))} aria-label="Neste uke">→</button>
        <button className="nav wide" onClick={() => setAnchor(startOfWeek(new Date()))}>Denne uken</button>
        <label className="toggle">
          <input type="checkbox" checked={showWeekend} onChange={(e) => setShowWeekend(e.target.checked)} />
          Helg
        </label>
      </nav>

      {permits.length === 0 ? (
        <div className="empty">
          <p>Ingen tillatelser er lagt inn ennå.</p>
          <button className="primary" onClick={() => setPanel("permits")}>Legg til p-tillatelse</button>
        </div>
      ) : (
        <div className="days">
          {week.map((date) => (
            <DayRow
              key={date}
              date={date}
              today={today}
              horizon={horizon}
              permits={permits}
              bookings={state.bookings.filter((b) => b.date === date)}
              blocks={state.blocks.filter((b) => b.date === date)}
              waitlist={state.waitlist.filter((w) => w.date === date).sort((a, b) => a.ts - b.ts)}
              me={me}
              onePerDay={state.settings.onePerDay}
              isAdmin={isAdmin}
              busy={busy}
              onBook={book}
              onRelease={release}
              onJoin={joinWaitlist}
              onLeave={leaveWaitlist}
              onAssign={(d, p) => setAssignTo({ date: d, permitId: p })}
              onBlock={(d, p) => setBlockFor({ date: d, permitId: p })}
              onUnblock={unblockBay}
              onAdminRemove={adminRemove}
            />
          ))}
        </div>
      )}

      <footer className="foot">
        <button className="link" onClick={() => setPanel("om")}>Slik deler du portalen</button>
        <span>Alle med lenken ser de samme bookingene.</span>
      </footer>

      {toast && <div className="toast">{toast}</div>}

      {panel === "permits" && (
        <Sheet title="P-tillatelser" onClose={() => setPanel(null)}>
          <PermitsPanel
            permits={permits}
            settings={state.settings}
            onAdd={addPermit}
            onUpdate={updatePermit}
            onRemove={removePermit}
            onSetting={setSetting}
          />
        </Sheet>
      )}
      {panel === "fordeling" && (
        <Sheet title="Fordeling siste 60 dager" onClose={() => setPanel(null)}>
          <Fordeling bookings={state.bookings} me={me} />
        </Sheet>
      )}
      {panel === "meg" && (
        <Sheet title="Din profil" onClose={() => setPanel(null)}>
          <Register
            current={{ name: me, plate: myPlate }}
            compact
            onSave={async (n, p) => { await saveProfile(n, p); setPanel(null); }}
            extra={
              <button className="ghost" onClick={() => { setPanel(null); setMailPrompt({ name: me, plate: myPlate }); }}>
                Send registreringen på nytt
              </button>
            }
          />
        </Sheet>
      )}
      {mailPrompt && (
        <Sheet title="Send til Autopay-ansvarlig" onClose={() => setMailPrompt(null)}>
          <MailPrompt info={mailPrompt} email={state.settings.adminEmail} onDone={() => setMailPrompt(null)} />
        </Sheet>
      )}
      {panel === "om" && (
        <Sheet title="Slik deler du portalen" onClose={() => setPanel(null)}>
          <div className="prose">
            <p>Send lenken til denne siden til kollegaene dine. Alle som åpner den skriver inn navnet sitt én gang og ser samme kalender og samme bookinger.</p>
            <p>Bookingene lagres delt, så alt du legger inn er synlig for alle som har lenken. Ikke legg inn noe du ikke vil at hele gruppen skal se.</p>
            <p>Regler som gjelder nå: én plass per person per dag{state.settings.onePerDay ? "" : " er slått av"}, og booking opptil {state.settings.horizonDays} dager fram i tid. Begge kan endres under «Tillatelser».</p>
          </div>
        </Sheet>
      )}
      {panel === "admin" && (
        <Sheet title="Admin" onClose={() => setPanel(null)}>
          <AdminPanel
            state={state}
            me={me}
            isAdmin={isAdmin}
            today={today}
            busy={busy}
            onUnlock={unlockAdmin}
            onLock={() => { rememberAdmin(false); setToast("Admin er låst."); }}
            onChangePin={changePin}
            onRemove={adminRemove}
            onUnblock={unblockBay}
            onDropWait={dropWaitlist}
            onPromote={promoteWaitlist}
            onClearFuture={clearFuture}
            onApprove={setApproved}
            onRemovePerson={removePerson}
            onSetting={setSetting}
          />
        </Sheet>
      )}
      {assignTo && (
        <Sheet title="Tildel plass" onClose={() => setAssignTo(null)}>
          <AssignDialog
            info={assignTo}
            permits={permits}
            names={knownNames}
            onSubmit={(name) => { assign(assignTo.date, assignTo.permitId, name); setAssignTo(null); }}
          />
        </Sheet>
      )}
      {blockFor && (
        <Sheet title="Sperr plass" onClose={() => setBlockFor(null)}>
          <BlockDialog
            info={blockFor}
            permits={permits}
            onSubmit={(reason) => { blockBay(blockFor.date, blockFor.permitId, reason); setBlockFor(null); }}
          />
        </Sheet>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/*  Dag + plasser                                                      */
/* ------------------------------------------------------------------ */

function DayRow({ date, today, horizon, permits, bookings, blocks, waitlist, me, onePerDay, isAdmin, busy, onBook, onRelease, onJoin, onLeave, onAssign, onBlock, onUnblock, onAdminRemove }) {
  const d = fromISO(date);
  const past = date < today;
  const beyond = date > horizon;
  const isToday = date === today;
  const mine = bookings.find((b) => b.user === me);
  const openBays = permits.filter(
    (p) => !bookings.some((b) => b.permitId === p.id) && !blocks.some((x) => x.permitId === p.id)
  ).length;
  const full = permits.length > 0 && openBays === 0;
  const onList = waitlist.some((w) => w.user === me);

  return (
    <section className={`day${past ? " past" : ""}${isToday ? " now" : ""}`}>
      <div className="date">
        <span className="dnum">{d.getDate()}</span>
        <span className="dname">{DAYS[dayIdx(date)]}</span>
        <span className="dmon">{MONTHS[d.getMonth()].slice(0, 3)}</span>
        {isToday && <span className="badge">I dag</span>}
      </div>

      <div className="bays">
        {permits.map((p) => {
          const b = bookings.find((x) => x.permitId === p.id);
          const blk = blocks.find((x) => x.permitId === p.id);

          if (b) {
            const isMine = b.user === me;
            return (
              <div key={p.id} className={`bay taken${isMine ? " mine" : ""}`}>
                <div className="tag">
                  <span className="tag-hole" />
                  <span className="plate">{p.label}</span>
                  {p.note && <span className="tag-note">{p.note}</span>}
                </div>
                <div className="bay-body">
                  <span className="holder">
                    {isMine ? "Din plass" : b.user}
                    {b.byAdmin && <em className="by">tildelt</em>}
                  </span>
                  <span className="acts">
                    {isMine && !past && <button className="ghost" disabled={busy} onClick={() => onRelease(b.id)}>Frigi</button>}
                    {isAdmin && !isMine && <button className="ghost warn" disabled={busy} onClick={() => onAdminRemove(b.id, false)}>Fjern</button>}
                  </span>
                </div>
              </div>
            );
          }

          if (blk) {
            return (
              <div key={p.id} className="bay blockedbay">
                <div className="tag empty">
                  <span className="plate">{p.label}</span>
                  <span className="tag-note">Sperret</span>
                </div>
                <div className="bay-body">
                  <span className="holder muted">{blk.reason || "Ikke tilgjengelig"}</span>
                  {isAdmin && <button className="ghost" disabled={busy} onClick={() => onUnblock(blk.id)}>Åpne</button>}
                </div>
              </div>
            );
          }

          const blocked = past || beyond;
          return (
            <div key={p.id} className={`bay free${blocked ? " blocked" : ""}`}>
              <div className="tag empty">
                <span className="plate">{p.label}</span>
                {p.note && <span className="tag-note">{p.note}</span>}
              </div>
              <div className="bay-body">
                <span className="holder muted">{past ? "Passert" : beyond ? "Åpner senere" : "Ledig"}</span>
                <span className="acts">
                  {isAdmin && !past && (
                    <>
                      <button className="ghost" disabled={busy} onClick={() => onAssign(date, p.id)}>Tildel</button>
                      <button className="ghost" disabled={busy} onClick={() => onBlock(date, p.id)}>Sperr</button>
                    </>
                  )}
                  {!blocked && (
                    <button
                      className="primary"
                      disabled={busy || (onePerDay && !!mine)}
                      title={onePerDay && mine ? "Regelen «én plass per person per dag» er på" : undefined}
                      onClick={() => onBook(date, p.id)}
                    >
                      {onePerDay && mine ? "Én per dag" : "Book"}
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        {full && !past && !mine && (
          <div className="waitrow">
            {onList ? (
              <>
                <span>Du står på ventelisten{waitlist.length > 1 ? ` (${waitlist.findIndex((w) => w.user === me) + 1} av ${waitlist.length})` : ""}.</span>
                <button className="ghost" disabled={busy} onClick={() => onLeave(date)}>Meld deg av</button>
              </>
            ) : (
              <>
                <span>Alle plassene er tatt.</span>
                <button className="ghost" disabled={busy} onClick={() => onJoin(date)}>Sett meg på venteliste</button>
              </>
            )}
          </div>
        )}
        {full && !past && waitlist.length > 0 && !onList && (
          <div className="waitrow quiet">Venteliste: {waitlist.map((w) => w.user).join(", ")}</div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Paneler                                                            */
/* ------------------------------------------------------------------ */

function PermitsPanel({ permits, settings, onAdd, onUpdate, onRemove, onSetting }) {
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(null);

  return (
    <div className="panel">
      <ul className="permit-list">
        {permits.map((p) => (
          <li key={p.id}>
            <input className="mini plate-in" value={p.label} onChange={(e) => onUpdate(p.id, { label: e.target.value })} aria-label="Kortnavn" />
            <input className="mini" value={p.note || ""} placeholder="Plassering eller eier" onChange={(e) => onUpdate(p.id, { note: e.target.value })} aria-label="Notat" />
            {confirm === p.id ? (
              <span className="confirm">
                <button className="danger" onClick={() => { onRemove(p.id); setConfirm(null); }}>Slett</button>
                <button className="ghost" onClick={() => setConfirm(null)}>Avbryt</button>
              </span>
            ) : (
              <button className="ghost" onClick={() => setConfirm(p.id)}>Fjern</button>
            )}
          </li>
        ))}
      </ul>

      <div className="addrow">
        <input className="mini plate-in" placeholder="P2" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Kortnavn" />
        <input className="mini" placeholder="F.eks. Snarøyveien, plan 2" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Plassering" />
        <button className="primary" onClick={() => { onAdd(label, note); setLabel(""); setNote(""); }}>Legg til</button>
      </div>
      <p className="hint">Å fjerne en tillatelse sletter også bookingene som er knyttet til den.</p>

      <div className="rules">
        <label className="rule">
          <input type="checkbox" checked={settings.onePerDay} onChange={(e) => onSetting({ onePerDay: e.target.checked })} />
          <span><strong>Én plass per person per dag</strong><em>Hindrer at én person tar flere tillatelser samme dag.</em></span>
        </label>
        <label className="rule">
          <span><strong>Book inntil</strong><em>Hvor langt fram i tid dagene åpner.</em></span>
          <select value={settings.horizonDays} onChange={(e) => onSetting({ horizonDays: Number(e.target.value) })}>
            {[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n} dager</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function Fordeling({ bookings, me }) {
  const cutoff = toISO(addDays(new Date(), -60));
  const counts = {};
  bookings.filter((b) => b.date >= cutoff).forEach((b) => { counts[b.user] = (counts[b.user] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;

  if (!rows.length) return <p className="hint">Ingen bookinger å vise ennå.</p>;

  return (
    <div className="panel">
      <ul className="bars">
        {rows.map(([name, n]) => (
          <li key={name} className={name === me ? "self" : ""}>
            <span className="bname">{name}</span>
            <span className="bar"><span style={{ width: `${(n / max) * 100}%` }} /></span>
            <span className="bcount">{n}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Dager booket de siste 60 dagene. Tallene er der for å gjøre det lett å se om fordelingen skjevner seg.</p>
    </div>
  );
}

function Register({ onSave, current, compact, extra }) {
  const [name, setName] = useState(current?.name || "");
  const [plate, setPlate] = useState(current?.plate || "");
  const ok = name.trim() && plateLooksOk(plate);
  return (
    <div className={compact ? "panel" : "gate"}>
      {!compact && (
        <>
          <span className="eyebrow">Delt p-tillatelse · Fornebu</span>
          <h2>Registrer deg</h2>
          <p>Navnet vises ved dagene du booker. Skiltnummeret trengs fordi parkeringen leses av kamera — bilen må ligge inne i Autopay for at tillatelsen skal gjelde.</p>
        </>
      )}
      <div className="fields">
        <label className="field">
          <span>Navn</span>
          <input className="mini" value={name} placeholder="Fornavn og etternavn" onChange={(e) => setName(e.target.value)} aria-label="Navn" />
        </label>
        <label className="field">
          <span>Bilskilt</span>
          <input
            className="mini plate-in wide"
            value={plate}
            placeholder="AB12345"
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && ok && onSave(name, plate)}
            aria-label="Bilskilt"
          />
        </label>
      </div>
      {plate && !plateLooksOk(plate) && <p className="hint warnhint">Skiltet ser ikke riktig ut. Skriv det som det står på bilen, f.eks. AB12345 eller EL54321.</p>}
      <div className="gate-row">
        <button className="primary" disabled={!ok} onClick={() => onSave(name, plate)}>
          {compact ? "Lagre" : "Registrer meg"}
        </button>
        {extra}
      </div>
      <p className="hint">
        {compact
          ? "Bytter du skilt, må bilen godkjennes i Autopay på nytt. Navn og skilt er synlig for admin."
          : "Skiltet sendes videre til den som legger bilene inn i Autopay. Det er synlig for admin, ikke for de andre i gruppen."}
      </p>
    </div>
  );
}

function MailPrompt({ info, email, onDone }) {
  const [copied, setCopied] = useState(false);
  const subject = `Autopay – ny bil: ${info.plate} (${info.name})`;
  const body = `Hei,\n\nLegg inn denne bilen i Autopay for p-tillatelsen på Fornebu:\n\nNavn: ${info.name}\nSkilt: ${info.plate}\n\nSendt fra bookingportalen for delt p-tillatelse.`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${info.name} – ${info.plate}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="panel">
      <p className="hint">Bilen din må inn i Autopay før parkeringen er godkjent. Send navn og skilt til {email} — e-posten er ferdig utfylt, du trenger bare å trykke send.</p>
      <div className="mailcard">
        <span className="plate big">{info.plate}</span>
        <span>{info.name}</span>
      </div>
      <div className="gate-row">
        <a className="primary aslink" href={mailto(email, subject, body)} onClick={() => setTimeout(onDone, 400)}>Åpne e-posten</a>
        <button className="ghost" onClick={copy}>{copied ? "Kopiert" : "Kopier i stedet"}</button>
      </div>
      <p className="hint">Åpner ikke e-postprogrammet seg, kopierer du bare linjen over og sender den til {email} på den måten du foretrekker. Registreringen din er lagret uansett, og admin ser den i listen.</p>
    </div>
  );
}

function AdminPanel({ state, me, isAdmin, today, busy, onUnlock, onLock, onChangePin, onRemove, onUnblock, onDropWait, onPromote, onClearFuture, onApprove, onRemovePerson, onSetting }) {
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [tab, setTab] = useState("personer");
  const [danger, setDanger] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstRun = !state.admin.pinHash;

  if (!isAdmin) {
    return (
      <div className="panel">
        <p className="hint">
          {firstRun
            ? "Ingen admin er satt opp ennå. PIN-koden du velger nå blir admin-koden for hele gruppen — den som kan den, kan overstyre bookinger."
            : `Admin ble satt opp av ${state.admin.setBy || "en i gruppen"}. Skriv PIN-koden for å låse opp.`}
        </p>
        <div className="gate-row">
          <input
            className="mini"
            type="password"
            inputMode="numeric"
            value={pin}
            placeholder={firstRun ? "Velg en PIN" : "PIN"}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pin.trim() && onUnlock(pin.trim())}
            aria-label="Admin-PIN"
          />
          <button className="primary" disabled={pin.trim().length < 4} onClick={() => onUnlock(pin.trim())}>
            {firstRun ? "Sett opp" : "Lås opp"}
          </button>
        </div>
        <p className="hint">Minst fire tegn. Koden ligger lagret som en enkel hash i den delte lagringen — den holder kollegaer ute, men er ingen sikkerhetsløsning.</p>
      </div>
    );
  }

  const upcoming = state.bookings.filter((b) => b.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const blocks = state.blocks.filter((b) => b.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const waits = [...state.waitlist].sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);
  const permitLabel = (id) => (state.permits.find((p) => p.id === id) || {}).label || "?";
  const dLabel = (iso) => `${DAYS_SHORT[dayIdx(iso)]} ${fromISO(iso).getDate()}.${fromISO(iso).getMonth() + 1}`;

  return (
    <div className="panel">
      <div className="adminbar">
        <span>Du er admin. Overstyringene ligger også rett i kalenderen.</span>
        <button className="ghost" onClick={onLock}>Lås</button>
      </div>

      <div className="tabs">
        {[
          ["personer", `Personer (${state.people.filter((p) => !p.approved).length ? `${state.people.filter((p) => !p.approved).length} nye` : state.people.length})`],
          ["bookinger", `Bookinger (${upcoming.length})`],
          ["venteliste", `Venteliste (${waits.length})`],
          ["sperret", `Sperret (${blocks.length})`],
          ["logg", "Logg"],
          ["kode", "PIN"],
        ].map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "personer" && <PeopleTab
        people={state.people}
        email={state.settings.adminEmail}
        busy={busy}
        copied={copied}
        setCopied={setCopied}
        onApprove={onApprove}
        onRemovePerson={onRemovePerson}
        onSetting={onSetting}
      />}

      {tab === "bookinger" && (
        upcoming.length === 0 ? <p className="hint">Ingen kommende bookinger.</p> : (
          <>
            <ul className="rows">
              {upcoming.map((b) => (
                <li key={b.id}>
                  <span className="rdate">{dLabel(b.date)}</span>
                  <span className="rplate">{permitLabel(b.permitId)}</span>
                  <span className="rname">{b.user}</span>
                  <button className="ghost warn" disabled={busy} onClick={() => onRemove(b.id, false)}>Fjern</button>
                </li>
              ))}
            </ul>
            <div className="dangerzone">
              {danger ? (
                <>
                  <span>Sletter alle {upcoming.length} kommende bookinger og hele ventelisten.</span>
                  <button className="danger" onClick={() => { onClearFuture(); setDanger(false); }}>Slett alt</button>
                  <button className="ghost" onClick={() => setDanger(false)}>Avbryt</button>
                </>
              ) : (
                <button className="ghost warn" onClick={() => setDanger(true)}>Nullstill kommende bookinger</button>
              )}
            </div>
          </>
        )
      )}

      {tab === "venteliste" && (
        waits.length === 0 ? <p className="hint">Ingen står på venteliste.</p> : (
          <ul className="rows">
            {waits.map((w) => (
              <li key={w.id}>
                <span className="rdate">{dLabel(w.date)}</span>
                <span className="rname wide">{w.user}</span>
                <button className="ghost" disabled={busy} onClick={() => onPromote(w.id)}>Gi plass</button>
                <button className="ghost warn" disabled={busy} onClick={() => onDropWait(w.id)}>Fjern</button>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === "sperret" && (
        blocks.length === 0 ? <p className="hint">Ingen dager er sperret. Sperr en plass fra kalenderen når tillatelsen er utlånt eller ute av bruk.</p> : (
          <ul className="rows">
            {blocks.map((b) => (
              <li key={b.id}>
                <span className="rdate">{dLabel(b.date)}</span>
                <span className="rplate">{permitLabel(b.permitId)}</span>
                <span className="rname">{b.reason || "Ikke tilgjengelig"}</span>
                <button className="ghost" disabled={busy} onClick={() => onUnblock(b.id)}>Åpne</button>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === "logg" && (
        state.log.length === 0 ? <p className="hint">Ingen hendelser ennå.</p> : (
          <ul className="log">
            {state.log.slice(0, 60).map((l) => (
              <li key={l.id}>
                <span className="ltime">{new Date(l.ts).toLocaleDateString("nb-NO", { day: "2-digit", month: "2-digit" })} {new Date(l.ts).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}</span>
                <span><strong>{l.actor}</strong> {l.text}</span>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === "kode" && (
        <>
          <p className="hint">Admin ble sist satt opp av {state.admin.setBy || "ukjent"}. Endrer du koden, må alle andre admin-er låse opp på nytt.</p>
          <div className="gate-row">
            <input className="mini" type="password" value={newPin} placeholder="Ny PIN" onChange={(e) => setNewPin(e.target.value)} aria-label="Ny PIN" />
            <button className="primary" disabled={newPin.trim().length < 4} onClick={() => { onChangePin(newPin.trim()); setNewPin(""); }}>Endre</button>
          </div>
        </>
      )}
    </div>
  );
}

function PeopleTab({ people, email, busy, copied, setCopied, onApprove, onRemovePerson, onSetting }) {
  const [editEmail, setEditEmail] = useState(false);
  const [draft, setDraft] = useState(email);
  const pending = people.filter((p) => !p.approved);
  const sorted = [...people].sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name, "nb"));

  async function copyAll(list) {
    const text = list.map((p) => `${p.plate}\t${p.name}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const digestBody = `Hei,\n\nDisse bilene mangler i Autopay for p-tillatelsen på Fornebu:\n\n${pending.map((p) => `${p.plate} – ${p.name}`).join("\n")}\n\nSendt fra bookingportalen.`;

  return (
    <>
      {people.length === 0 ? (
        <p className="hint">Ingen har registrert seg ennå. Skiltene dukker opp her så snart de gjør det.</p>
      ) : (
        <>
          <ul className="rows">
            {sorted.map((p) => (
              <li key={p.id} className={p.approved ? "" : "pendingrow"}>
                <span className="rplate wide">{p.plate}</span>
                <span className="rname">{p.name}</span>
                <button
                  className={p.approved ? "ghost" : "primary"}
                  disabled={busy}
                  onClick={() => onApprove(p.id, !p.approved)}
                  title={p.approved ? "Merk som ikke lagt inn" : "Merk som lagt inn i Autopay"}
                >
                  {p.approved ? "I Autopay" : "Merk lagt inn"}
                </button>
                <button className="ghost warn" disabled={busy} onClick={() => onRemovePerson(p.id)}>Fjern</button>
              </li>
            ))}
          </ul>
          <div className="dangerzone">
            <button className="ghost" onClick={() => copyAll(pending.length ? pending : people)}>
              {copied ? "Kopiert" : `Kopier ${pending.length ? "nye" : "alle"} skilt`}
            </button>
            {pending.length > 0 && (
              <a className="ghost aslink" href={mailto(email, `Autopay – ${pending.length} nye biler`, digestBody)}>Send samlet på e-post</a>
            )}
          </div>
        </>
      )}

      <div className="rules">
        <div className="rule">
          <span><strong>Autopay-ansvarlig</strong><em>{editEmail ? "Hit går registreringene." : email}</em></span>
          {editEmail ? (
            <span className="confirm">
              <input className="mini" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="E-post" />
              <button className="primary" onClick={() => { onSetting({ adminEmail: draft.trim() }); setEditEmail(false); }}>Lagre</button>
            </span>
          ) : (
            <button className="ghost" onClick={() => { setDraft(email); setEditEmail(true); }}>Endre</button>
          )}
        </div>
      </div>
      <p className="hint">Skiltene lagres i den delte lagringen, men vises bare her og for personen selv. Portalen kan ikke sende e-post av seg selv — knappene åpner en ferdig utfylt e-post i ditt eget program.</p>
    </>
  );
}

function AssignDialog({ info, permits, names, onSubmit }) {
  const [name, setName] = useState("");
  const p = permits.find((x) => x.id === info.permitId);
  const d = fromISO(info.date);
  return (
    <div className="panel">
      <p className="hint">{DAYS[dayIdx(info.date)]} {d.getDate()}. {MONTHS[d.getMonth()]} · {p ? p.label : ""}</p>
      <div className="gate-row">
        <input
          className="mini"
          value={name}
          placeholder="Navn på den som skal ha plassen"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onSubmit(name)}
          aria-label="Navn"
        />
        <button className="primary" disabled={!name.trim()} onClick={() => onSubmit(name)}>Tildel</button>
      </div>
      {names.length > 0 && (
        <div className="quick">
          {names.slice(0, 12).map((n) => (
            <button key={n} className="chip" onClick={() => setName(n)}>{n}</button>
          ))}
        </div>
      )}
      <p className="hint">Tildeling går forbi regelen om én plass per dag.</p>
    </div>
  );
}

function BlockDialog({ info, permits, onSubmit }) {
  const [reason, setReason] = useState("");
  const p = permits.find((x) => x.id === info.permitId);
  const d = fromISO(info.date);
  return (
    <div className="panel">
      <p className="hint">{DAYS[dayIdx(info.date)]} {d.getDate()}. {MONTHS[d.getMonth()]} · {p ? p.label : ""}</p>
      <div className="gate-row">
        <input
          className="mini"
          value={reason}
          placeholder="Grunn, f.eks. «tillatelsen er utlånt»"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit(reason)}
          aria-label="Grunn"
        />
        <button className="primary" onClick={() => onSubmit(reason)}>Sperr</button>
      </div>
      <p className="hint">Sperret plass kan ingen booke. Grunnen vises i kalenderen, så kollegaene skjønner hvorfor.</p>
    </div>
  );
}

function Sheet({ title, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-top">
          <h3>{title}</h3>
          <button className="ghost" onClick={onClose}>Lukk</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Skall og stil                                                      */
/* ------------------------------------------------------------------ */

function Shell({ children }) {
  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="wrap">{children}</div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

.app{
  --asphalt:#14161a; --asphalt2:#1c1f26; --line:#2b2f38; --line2:#3a3f4a;
  --chalk:#eef0f3; --concrete:#8d949f; --paint:#ffc72c; --go:#4cc38a; --stop:#e2574c;
  --disp:'Barlow Condensed','Oswald','Arial Narrow',system-ui,sans-serif;
  --body:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  background:var(--asphalt); color:var(--chalk); font-family:var(--body);
  min-height:100%; padding:20px 16px 40px; -webkit-font-smoothing:antialiased;
}
.app *{box-sizing:border-box}
.wrap{max-width:940px;margin:0 auto}
.app button{font:inherit;cursor:pointer;border:none;border-radius:8px}
.app button:focus-visible,.app input:focus-visible,.app select:focus-visible{outline:2px solid var(--paint);outline-offset:2px}
.skeleton{height:220px;border-radius:12px;background:var(--asphalt2)}

.eyebrow{font-family:var(--disp);text-transform:uppercase;letter-spacing:.18em;font-size:12px;color:var(--paint)}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
.brand h1{font-family:var(--disp);font-size:42px;line-height:.95;margin:2px 0 0;letter-spacing:.01em;text-transform:uppercase}
.top-actions{display:flex;gap:8px;flex-wrap:wrap}
.chip{background:var(--asphalt2);color:var(--chalk);border:1px solid var(--line);padding:7px 12px;font-size:13px}
.chip:hover{border-color:var(--line2)}
.chip.who{display:flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--paint);display:inline-block}

.banner{background:#2a1e1e;border:1px solid #59322e;color:#f3c8c4;padding:10px 12px;border-radius:10px;margin-bottom:14px;display:flex;gap:10px;align-items:center;font-size:14px}
.link{background:none;color:var(--paint);text-decoration:underline;padding:0}

.mine{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.mine-label{font-family:var(--disp);text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:var(--concrete)}
.mine-list{display:flex;gap:6px;flex-wrap:wrap}
.mine-tag{background:var(--paint);color:#191919;font-size:12px;font-weight:600;padding:4px 9px;border-radius:6px;display:flex;gap:6px;align-items:center}
.mine-tag em{font-style:normal;opacity:.62;font-family:var(--disp);letter-spacing:.06em}

.weeknav{display:flex;align-items:center;gap:8px;padding:10px 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px}
.nav{background:var(--asphalt2);border:1px solid var(--line);color:var(--chalk);width:36px;height:36px;font-size:15px}
.nav.wide{width:auto;padding:0 12px;font-size:13px}
.weeklabel{display:flex;flex-direction:column;line-height:1.2;margin:0 4px;flex:1}
.weeklabel strong{font-family:var(--disp);font-size:20px;text-transform:uppercase;letter-spacing:.05em}
.weeklabel span{font-size:12px;color:var(--concrete)}
.toggle{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--concrete);cursor:pointer}
.toggle input{accent-color:var(--paint)}

.days{display:flex;flex-direction:column;gap:10px}
.day{display:grid;grid-template-columns:92px 1fr;gap:14px;background:var(--asphalt2);border:1px solid var(--line);border-radius:12px;padding:14px}
.day.now{border-color:var(--paint)}
.day.past{opacity:.45}
.date{display:flex;flex-direction:column;gap:1px;border-right:1px solid var(--line);padding-right:12px}
.dnum{font-family:var(--disp);font-size:34px;line-height:1}
.dname{font-size:13px;font-weight:500}
.dmon{font-size:12px;color:var(--concrete);text-transform:uppercase;letter-spacing:.1em}
.badge{margin-top:6px;align-self:flex-start;background:var(--paint);color:#191919;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:2px 6px;border-radius:4px}

.bays{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;align-content:start}
.bay{border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:10px;min-height:96px;justify-content:space-between}
.bay.free{border:2px dashed var(--line2);background:transparent}
.bay.taken{border:1px solid var(--line2);background:#22262e}
.bay.mine{background:#2b2718;border-color:var(--paint)}
.bay.blocked{opacity:.5}

.tag{position:relative;display:flex;flex-direction:column;gap:1px;background:var(--paint);color:#191919;border-radius:6px;padding:6px 10px 6px 22px;align-self:flex-start}
.tag-hole{position:absolute;left:8px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--asphalt2);box-shadow:inset 0 0 0 1px rgba(0,0,0,.3)}
.tag.empty{background:transparent;color:var(--concrete);border:1px solid var(--line2);padding-left:10px}
.plate{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:.12em;text-transform:uppercase;line-height:1.05}
.tag-note{font-size:11px;letter-spacing:.02em;opacity:.72}
.bay-body{display:flex;align-items:center;justify-content:space-between;gap:8px}
.holder{font-size:13px;font-weight:500}
.holder.muted{color:var(--concrete)}

.primary{background:var(--paint);color:#191919;font-weight:600;font-size:13px;padding:7px 13px}
.primary:disabled{background:var(--line2);color:var(--concrete);cursor:not-allowed}
.ghost{background:transparent;border:1px solid var(--line2);color:var(--chalk);font-size:13px;padding:6px 11px}
.ghost:hover{border-color:var(--concrete)}
.danger{background:var(--stop);color:#fff;font-size:13px;padding:6px 11px}

.waitrow{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:10px;font-size:13px;color:var(--concrete)}
.waitrow.quiet{border-top:none;padding-top:0;font-size:12px}

.empty{text-align:center;padding:44px 16px;border:2px dashed var(--line2);border-radius:12px}
.empty p{color:var(--concrete);margin:0 0 14px}

.foot{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:22px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--concrete)}

.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--chalk);color:#191919;font-size:13px;font-weight:500;padding:10px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:92vw;text-align:center;z-index:60}

.scrim{position:fixed;inset:0;background:rgba(8,9,11,.72);display:flex;align-items:flex-end;justify-content:center;padding:16px;z-index:50}
.sheet{background:var(--asphalt2);border:1px solid var(--line2);border-radius:14px;padding:18px;width:100%;max-width:620px;max-height:86vh;overflow:auto}
.sheet-top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
.sheet-top h3{font-family:var(--disp);font-size:24px;text-transform:uppercase;letter-spacing:.06em;margin:0}
.panel{display:flex;flex-direction:column;gap:14px}
.prose p{font-size:14px;line-height:1.55;color:#cfd4db;margin:0 0 10px}

.mini{background:var(--asphalt);border:1px solid var(--line2);color:var(--chalk);border-radius:8px;padding:8px 10px;font-size:14px;font-family:var(--body);width:100%}
.plate-in{max-width:88px;font-family:var(--disp);letter-spacing:.1em;text-transform:uppercase;font-weight:700}
.permit-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.permit-list li{display:flex;gap:8px;align-items:center}
.confirm{display:flex;gap:6px}
.addrow{display:flex;gap:8px;align-items:center;border-top:1px solid var(--line);padding-top:14px}
.hint{font-size:12px;color:var(--concrete);margin:0;line-height:1.5}
.rules{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--line);padding-top:14px}
.rule{display:flex;gap:10px;align-items:center;justify-content:space-between;font-size:14px}
.rule input{accent-color:var(--paint);width:18px;height:18px;flex:none}
.rule span{display:flex;flex-direction:column}
.rule em{font-style:normal;font-size:12px;color:var(--concrete)}
.rule select{background:var(--asphalt);border:1px solid var(--line2);color:var(--chalk);border-radius:8px;padding:7px 9px;font-size:13px}

.bars{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.bars li{display:grid;grid-template-columns:110px 1fr 28px;gap:10px;align-items:center;font-size:13px}
.bar{height:9px;background:var(--line);border-radius:5px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--line2)}
.bars li.self .bar span{background:var(--paint)}
.bcount{text-align:right;color:var(--concrete)}

.gate{max-width:440px;margin:8vh auto 0;text-align:left}

.chip.admin-on{border-color:var(--paint);color:var(--paint)}
.acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.ghost.warn{border-color:#5c3430;color:#f0a49c}
.ghost.warn:hover{border-color:var(--stop)}
.holder .by{font-style:normal;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--concrete);margin-left:6px}
.bay.blockedbay{border:1px solid var(--line2);background:repeating-linear-gradient(135deg,#1f2229,#1f2229 8px,#252932 8px,#252932 16px)}

.adminbar{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#2b2718;border:1px solid var(--paint);border-radius:10px;padding:9px 12px;font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}
.tab{background:transparent;border:1px solid var(--line);color:var(--concrete);font-size:12px;padding:6px 10px}
.tab.on{border-color:var(--paint);color:var(--paint)}
.rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:44vh;overflow:auto}
.rows li{display:flex;align-items:center;gap:8px;background:var(--asphalt);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13px}
.rdate{width:66px;color:var(--concrete);flex:none}
.rplate{font-family:var(--disp);font-weight:700;letter-spacing:.08em;color:var(--paint);width:42px;flex:none}
.rname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rname.wide{flex:1}
.dangerzone{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px;font-size:13px;color:var(--concrete)}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;max-height:48vh;overflow:auto;font-size:12.5px}
.log li{display:flex;gap:10px;color:#cfd4db}
.ltime{color:var(--concrete);flex:none;font-variant-numeric:tabular-nums}
.quick{display:flex;gap:6px;flex-wrap:wrap}
.fields{display:flex;flex-direction:column;gap:10px}
.field{display:flex;flex-direction:column;gap:5px}
.field>span{font-size:12px;color:var(--concrete);text-transform:uppercase;letter-spacing:.1em;font-family:var(--disp)}
.plate-in.wide{max-width:180px;font-size:19px;padding:9px 12px}
.warnhint{color:#f0a49c}
.banner.pending{background:#2b2718;border-color:var(--paint);color:#f0e2b8}
.aslink{display:inline-flex;align-items:center;text-decoration:none;border-radius:8px}
a.primary.aslink{padding:8px 14px}
a.ghost.aslink{padding:6px 11px;font-size:13px;color:var(--chalk)}
.mailcard{display:flex;align-items:center;gap:12px;background:var(--asphalt);border:1px solid var(--line2);border-radius:10px;padding:12px;font-size:14px}
.plate.big{background:var(--paint);color:#191919;padding:5px 12px;border-radius:5px;font-size:22px}
.rplate.wide{width:auto;min-width:74px}
.rows li.pendingrow{border-color:var(--paint)}
.gate h2{font-family:var(--disp);font-size:34px;text-transform:uppercase;margin:6px 0 8px;letter-spacing:.02em}
.gate p{color:var(--concrete);font-size:14px;line-height:1.55;margin:0 0 18px}
.gate-row{display:flex;gap:8px}

@media (max-width:560px){
  .day{grid-template-columns:1fr;gap:10px}
  .date{flex-direction:row;align-items:baseline;gap:8px;border-right:none;border-bottom:1px solid var(--line);padding:0 0 8px}
  .badge{margin-top:0}
  .brand h1{font-size:34px}
  .bays{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){.app *{animation:none!important;transition:none!important}}
`;
