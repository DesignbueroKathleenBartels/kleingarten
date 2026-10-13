/* Kleingarten – Datenanbindung an Supabase.
   Stellt dieselbe Schnittstelle bereit, die die App bisher in Claude genutzt hat:
   db.collection(c).onSnapshot(cb), db.doc("c/id").set|update|delete, assets.upload|delete|list, user.can(). */
(() => {
  "use strict";
  const cfg = window.KG_CONFIG || {};
  const CACHE_KEY = "kg-cache-v1";
  const BUCKET = "fotos";
  const QUOTA = 1024 * 1024 * 1024; // 1 GB im kostenlosen Supabase-Konto

  const configured = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "kg-auth" }
  }) : null;

  /* ---------- lokaler Zwischenspeicher (für offline) ---------- */
  const data = {};          // collection -> Map(id -> doc)
  const subs = {};          // collection -> [cb]
  let loaded = false;
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c) Object.entries(c).forEach(([k, v]) => { data[k] = new Map(Object.entries(v)); });
  } catch (e) {}
  let saveT = null;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { const o = {}; Object.entries(data).forEach(([k, m]) => { o[k] = Object.fromEntries(m); }); localStorage.setItem(CACHE_KEY, JSON.stringify(o)); } catch (e) {}
    }, 300);
  }
  const col = c => data[c] || (data[c] = new Map());
  function snap(c) {
    return { docs: [...col(c).entries()].map(([id, v]) => ({ id, exists: true, data: () => JSON.parse(JSON.stringify(v)) })) };
  }
  function emit(c) { (subs[c] || []).forEach(f => { try { f(snap(c)); } catch (e) { console.error(e); } }); }
  function apply(c, id, v) { if (v == null) col(c).delete(id); else col(c).set(id, v); persist(); emit(c); }

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }
  function mapErr(e) {
    if (!e) return err("unknown");
    if (e.code === "42501" || /row-level security|permission|JWT|not authorized/i.test(e.message || "")) return err("invalid_argument", "Keine Berechtigung");
    if (/Failed to fetch|NetworkError|network/i.test(e.message || "")) return err("offline", "Keine Verbindung");
    return err(e.code || "unknown", e.message);
  }

  /* ---------- Laden & Live-Abgleich ---------- */
  async function loadAll() {
    if (!sb) return;
    const all = []; const step = 1000;
    for (let from = 0; ; from += step) {
      const { data: rows, error } = await sb.from("docs").select("collection,id,data").range(from, from + step - 1);
      if (error) throw mapErr(error);
      all.push(...rows); if (rows.length < step) break;
    }
    const fresh = {};
    all.forEach(r => { (fresh[r.collection] || (fresh[r.collection] = new Map())).set(r.id, r.data); });
    const names = new Set([...Object.keys(data), ...Object.keys(fresh)]);
    names.forEach(c => { data[c] = fresh[c] || new Map(); });
    loaded = true; persist();
    names.forEach(emit);
  }
  let channel = null;
  function listen() {
    if (!sb || channel) return;
    channel = sb.channel("kg-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
        if (p.eventType === "DELETE") { const o = p.old || {}; if (o.collection && o.id) apply(o.collection, o.id, null); }
        else { const n = p.new; if (n && n.collection) apply(n.collection, n.id, n.data); }
      })
      .subscribe(status => { if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { channel = null; setTimeout(listen, 5000); } });
  }
  // Nach Rückkehr in die App oder bei wiederhergestellter Verbindung neu laden
  const refresh = () => { if (document.visibilityState === "visible") loadAll().catch(() => {}); };
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("online", refresh);

  const db = {
    collection: c => ({
      onSnapshot(cb, onErr) {
        (subs[c] || (subs[c] = [])).push(cb);
        if (data[c]) setTimeout(() => cb(snap(c)), 0);
        return () => { subs[c] = (subs[c] || []).filter(f => f !== cb); };
      }
    }),
    doc(path) {
      const [c, id] = path.split("/");
      const write = async v => {
        if (!sb) throw err("invalid_argument");
        const { error } = await sb.from("docs").upsert({ collection: c, id, data: v, updated_at: new Date().toISOString() });
        if (error) throw mapErr(error);
        apply(c, id, v);
      };
      return {
        set: v => write(v),
        update: async patch => {
          const cur = col(c).get(id) || {};
          const next = { ...cur };
          Object.entries(patch).forEach(([k, v]) => { if (v && v.__delete__) delete next[k]; else next[k] = v; });
          return write(next);
        },
        delete: async () => {
          if (!sb) throw err("invalid_argument");
          const { error } = await sb.from("docs").delete().eq("collection", c).eq("id", id);
          if (error) throw mapErr(error);
          apply(c, id, null);
        }
      };
    }
  };

  /* ---------- Fotos ---------- */
  const assets = {
    async upload(blob, opt) {
      const ext = /png/.test(opt && opt.type) ? "png" : "jpg";
      const name = `${new Date().toISOString().slice(0, 7)}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(name, blob, { contentType: (opt && opt.type) || "image/jpeg", cacheControl: "31536000", upsert: false });
      if (error) { const e = mapErr(error); if (/exceeded|quota|size/i.test(error.message || "")) e.code = "too_large"; throw e; }
      return { id: name };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw mapErr(error); },
    async list() {
      let used = 0;
      const walk = async prefix => {
        const { data: items, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000 });
        if (error || !items) return;
        for (const it of items) {
          if (it.id === null) await walk(prefix ? prefix + "/" + it.name : it.name);
          else used += (it.metadata && it.metadata.size) || 0;
        }
      };
      await walk("");
      return { usage: { usedBytes: used, quotaBytes: QUOTA } };
    }
  };
  function blobUrl(id) {
    return configured ? `${cfg.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${String(id).split("/").map(encodeURIComponent).join("/")}` : "";
  }

  /* ---------- Anmeldung ---------- */
  let session = null;
  const auth = {
    get configured() { return configured; },
    get user() { return session && session.user; },
    async init() {
      if (!sb) return null;
      const { data: d } = await sb.auth.getSession(); session = d.session;
      sb.auth.onAuthStateChange((_e, s) => {
        const was = !!session; session = s;
        if (was !== !!s) location.reload();
      });
      return session;
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw err(/invalid/i.test(error.message) ? "bad_login" : "login_failed", error.message);
    },
    async signOut() { await sb.auth.signOut(); },
    async setPassword(password) { const { error } = await sb.auth.updateUser({ password }); if (error) throw err("pw_failed", error.message); }
  };

  /* ---------- Sicherung: Export & Import ---------- */
  function exportAll() {
    const o = {}; Object.entries(data).forEach(([k, m]) => { o[k] = Object.fromEntries(m); }); return o;
  }
  async function importAll(obj, onProgress) {
    const rows = [];
    Object.entries(obj || {}).forEach(([c, docs]) => {
      if (!docs || typeof docs !== "object" || !/^[a-z_]+$/i.test(c)) return;
      Object.entries(docs).forEach(([id, v]) => { if (v && typeof v === "object") rows.push({ collection: c, id, data: v, updated_at: new Date().toISOString() }); });
    });
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("docs").upsert(rows.slice(i, i + 200));
      if (error) throw mapErr(error);
      onProgress && onProgress(Math.min(rows.length, i + 200), rows.length);
    }
    await loadAll();
    return rows.length;
  }

  /* ---------- Schnittstelle wie in Claude ---------- */
  let ready = null;
  async function start() {
    if (ready) return ready;
    ready = (async () => {
      await auth.init().catch(() => null);
      try { await loadAll(); listen(); } catch (e) { /* offline: Zwischenspeicher nutzen */ }
    })();
    return ready;
  }
  window.KG = { auth, blobUrl, exportAll, importAll, get online() { return loaded; }, configured };
  window.claude = {
    use: async name => {
      await start();
      if (name === "db") return configured || Object.keys(data).length ? db : null;
      if (name === "user") return { can: async () => !!session };
      if (name === "assets") return session ? assets : null;
      return null; // keine Fragen-Funktion
    }
  };
})();
