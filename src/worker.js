// PharmaLife POS — Cloudflare Worker: serves the app from /public and stores data in D1 (binding DB)
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS rec (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL, ord INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (coll, id))",
  "CREATE INDEX IF NOT EXISTS rec_rev ON rec (rev)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sess (token TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 0)",
  "DELETE FROM rec WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'fresh_2026_10_17')",
  "DELETE FROM sess WHERE NOT EXISTS (SELECT 1 FROM meta WHERE k = 'fresh_2026_10_17')",
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('fresh_2026_10_17', 1)",
];
const ADMIN_USER = 'admin', ADMIN_PW = '123456@#', SESSION_MS = 12 * 3600 * 1000;
const REV = "(SELECT v FROM meta WHERE k = 'rev')";
let ready = false;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const uname = u => u.username || (u.id === 'u1' ? 'admin' : String(u.name || '').replace(/^Dr\.\s*/, '').split(/\s+/)[0].toLowerCase());
const strip = (c, d) => { if (c === 'users' && d && typeof d === 'object') { const { password, ...r } = d; return r; } return d; };
const chunk = (arr, max = 400000) => { const out = []; let cur = [], size = 0; arr.forEach(x => { const s = JSON.stringify(x).length; if (cur.length && size + s > max) { out.push(cur); cur = []; size = 0; } cur.push(x); size += s; }); if (cur.length) out.push(cur); return out; };

async function init(db) { if (ready) return; await db.batch(SCHEMA.map(s => db.prepare(s))); ready = true; }
const bearer = req => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
async function auth(db, req) {
  const t = bearer(req); if (!t) return null;
  const r = await db.prepare('SELECT uid FROM sess WHERE token = ? AND exp > ?').bind(t, Date.now()).first();
  if (!r) return null;
  const u = await db.prepare("SELECT data FROM rec WHERE coll = 'users' AND id = ? AND del = 0").bind(r.uid).first();
  if (u) { const d = JSON.parse(u.data); if (d.status && d.status !== 'Active') return null; }
  return r.uid;
}

async function handleApi(request, env, path) {
  const db = env.DB;
  if (!db) return json({ error: 'Database not connected. Check the d1_databases section in wrangler.jsonc.' }, 500);
  await init(db);
  const method = request.method;

  if (path === '/ping') return json({ ok: true });

  if (path === '/login' && method === 'POST') {
    const { username = '', password = '' } = await request.json().catch(() => ({}));
    const q = String(username).trim().toLowerCase();
    const rows = (await db.prepare("SELECT data FROM rec WHERE coll = 'users' AND del = 0").all()).results || [];
    const fresh = rows.length === 0;
    let uid = null;
    if (fresh) { if (q === ADMIN_USER && password === ADMIN_PW) uid = 'u1'; }
    else {
      const u = rows.map(r => JSON.parse(r.data)).find(x => uname(x).toLowerCase() === q);
      if (u && u.password === password) {
        if (u.status && u.status !== 'Active') return json({ error: 'This account is ' + String(u.status).toLowerCase() + '. Contact the Super Admin.' }, 403);
        uid = u.id;
      }
    }
    if (!uid) return json({ error: 'That username and password don’t match an account.' }, 401);
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    await db.batch([
      db.prepare('DELETE FROM sess WHERE exp < ?').bind(Date.now()),
      db.prepare('INSERT INTO sess (token, uid, exp) VALUES (?, ?, ?)').bind(token, uid, Date.now() + SESSION_MS),
    ]);
    return json({ token, uid, fresh });
  }

  const uid = await auth(db, request);
  if (!uid) return json({ error: 'Session expired. Sign in again.' }, 401);

  if (path === '/logout') { await db.prepare('DELETE FROM sess WHERE token = ?').bind(bearer(request)).run(); return json({ ok: true }); }

  if (path === '/changes') {
    const since = +new URL(request.url).searchParams.get('since') || 0;
    const rev = (await db.prepare("SELECT v FROM meta WHERE k = 'rev'").first()).v;
    const rows = (await db.prepare('SELECT coll, id, data, del, ord FROM rec WHERE rev > ? ORDER BY ord').bind(since).all()).results || [];
    return json({ rev, rows: rows.filter(r => since > 0 || !r.del).map(r => ({ c: r.coll, id: r.id, del: !!r.del, ord: r.ord, data: r.del ? null : strip(r.coll, JSON.parse(r.data)) })) });
  }

  if (path === '/sync' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Bad request' }, 400);
    const up = body.up || {}, del = body.del || {}, single = body.single || {};
    const colls = Object.keys(up);
    const existing = {}, oldData = {};
    if (colls.length || Object.keys(single).length) {
      const need = [...new Set([...colls, '_single'])];
      const rows = (await db.prepare("SELECT coll, id, del, CASE WHEN coll IN ('users', 'products', '_single') THEN data END AS data FROM rec WHERE coll IN (" + need.map(() => '?').join(',') + ')').bind(...need).all()).results || [];
      rows.forEach(r => { (existing[r.coll] = existing[r.coll] || new Set()).add(r.id); if (r.data && !r.del) (oldData[r.coll] = oldData[r.coll] || new Map()).set(r.id, JSON.parse(r.data)); });
    }
    const renames = [], items = [];
    colls.forEach(c => {
      const ex = existing[c] || (existing[c] = new Set()), od = oldData[c] || new Map();
      (up[c] || []).forEach(it => {
        let id = String(it.id), data;
        try { data = JSON.parse(it.d); } catch (e) { return; }
        if (it.isNew && ex.has(id) && c !== 'products' && c !== 'users' && c !== 'audit') {
          const m = id.match(/^(.*?)(\d+)$/);
          if (m) { let n = +m[2]; while (ex.has(m[1] + n)) n++; const nid = m[1] + n; renames.push({ c, from: id, to: nid }); id = nid; if (data && data.no !== undefined) data.no = nid; }
        }
        const old = od.get(id);
        if (c === 'users' && old && !data.password && old.password) data.password = old.password;
        if (c === 'products' && old && !it.isNew && typeof it.dStock === 'number' && typeof old.stock === 'number') data.stock = old.stock + it.dStock;
        ex.add(id);
        items.push({ c, id, d: JSON.stringify(data) });
      });
    });
    Object.keys(single).forEach(k => {
      let v; try { v = JSON.parse(single[k]); } catch (e) { return; }
      const old = (oldData._single || new Map()).get(k);
      if (k === 'seq' && old && typeof old === 'object' && v && typeof v === 'object') { Object.keys(old).forEach(x => { v[x] = Math.max(+v[x] || 0, +old[x] || 0); }); }
      if (k === 'saleNo' && typeof old === 'number') v = Math.max(+v || 0, old);
      items.push({ c: '_single', id: k, d: JSON.stringify(v) });
    });
    const dels = []; Object.keys(del).forEach(c => (del[c] || []).forEach(id => dels.push(c + '\u001f' + id)));
    if (!items.length && !dels.length) return json({ ok: true, renames });
    const stmts = [db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rev'")];
    chunk(items).forEach((part, pi) => stmts.push(db.prepare(
      "INSERT INTO rec (coll, id, data, rev, ord, del) SELECT json_extract(value, '$.c'), json_extract(value, '$.id'), json_extract(value, '$.d'), " + REV + ", " + REV + " * 1000000 + " + (pi * 100000) + " + key, 0 FROM json_each(?) WHERE true ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, del = 0"
    ).bind(JSON.stringify(part))));
    chunk(dels).forEach(part => stmts.push(db.prepare(
      "UPDATE rec SET del = 1, data = NULL, rev = " + REV + " WHERE (coll || char(31) || id) IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(part))));
    await db.batch(stmts);
    return json({ ok: true, renames });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, url.pathname.slice(4)); }
      catch (e) { return json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
