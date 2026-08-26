import { createClient } from "@supabase/supabase-js";

/*
 * Lagringslag.
 *
 * Beholder samme lille API som appen brukte før — get/set med et
 * "shared"-flagg — slik at resten av koden er uendret:
 *
 *   shared = true   → delt tilstand for hele gruppen (Supabase)
 *   shared = false  → personlig, kun denne nettleseren (localStorage)
 *
 * Mangler Supabase-nøklene, faller alt tilbake til localStorage. Da
 * virker appen fint på én maskin, men ingenting deles. Nyttig under
 * utvikling, ubrukelig i produksjon — derfor varsler UI-et om det.
 */

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const ROW_ID = import.meta.env.VITE_STATE_ID || "fornebu";
const TABLE = "app_state";

export const mode = URL && ANON ? "shared" : "local";
const sb = mode === "shared" ? createClient(URL, ANON, { auth: { persistSession: false } }) : null;

/* ------------------------------ lokalt ------------------------------ */

function localGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { key, value: raw } : null;
  } catch {
    return null;
  }
}

function localSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* privat modus eller full disk – vi lar det gå stille */
  }
  return { key, value };
}

/* ------------------------------ delt -------------------------------- */

async function sharedGet() {
  if (!sb) return localGet("shared-fallback");
  const { data, error } = await sb.from(TABLE).select("data").eq("id", ROW_ID).maybeSingle();
  if (error) throw error;
  return data ? { key: ROW_ID, value: JSON.stringify(data.data) } : null;
}

async function sharedSet(value) {
  if (!sb) return localSet("shared-fallback", value);
  const { error } = await sb
    .from(TABLE)
    .upsert({ id: ROW_ID, data: JSON.parse(value), updated_at: new Date().toISOString() });
  if (error) throw error;
  return { key: ROW_ID, value };
}

/* ------------------------------- API -------------------------------- */

export const storage = {
  mode,

  async get(key, shared = false) {
    return shared ? sharedGet() : localGet(key);
  },

  async set(key, value, shared = false) {
    return shared ? sharedSet(value) : localSet(key, value);
  },

  /*
   * Kaller cb med ny delt tilstand når noen andre endrer noe.
   * Realtime først, med polling som sikkerhetsnett hvis websocket
   * blir stoppet av et bedriftsnett.
   */
  subscribe(cb) {
    if (!sb) return () => {};

    const channel = sb
      .channel(`state:${ROW_ID}`)
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: `id=eq.${ROW_ID}` }, (payload) => {
        if (payload.new?.data) cb(payload.new.data);
      })
      .subscribe();

    const poll = setInterval(async () => {
      try {
        const r = await sharedGet();
        if (r) cb(JSON.parse(r.value));
      } catch {
        /* nettverket kommer tilbake, eller så gjør det ikke det */
      }
    }, 30000);

    return () => {
      clearInterval(poll);
      sb.removeChannel(channel);
    };
  },
};
