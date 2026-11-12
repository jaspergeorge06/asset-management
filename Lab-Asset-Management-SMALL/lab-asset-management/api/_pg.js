// Gives the server code a tiny "prepare/bind/first/all/run/batch" database interface on top of Postgres (Neon on Vercel).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', is_active INTEGER NOT NULL DEFAULT 1, verified INTEGER NOT NULL DEFAULT 0, created_date TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created DOUBLE PRECISION NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS codes (email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires DOUBLE PRECISION NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at DOUBLE PRECISION NOT NULL, PRIMARY KEY (email, purpose))`,
  `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL UNIQUE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', invited_by TEXT, created_date TEXT NOT NULL, accepted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_inv_email ON invitations(email)`,
  `CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires DOUBLE PRECISION NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS records (seq BIGSERIAL, store TEXT NOT NULL, id TEXT NOT NULL, created_date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (store, id))`,
  `CREATE INDEX IF NOT EXISTS idx_records_created ON records(store, created_date)`,
  `CREATE TABLE IF NOT EXISTS assets (seq BIGSERIAL, id TEXT PRIMARY KEY, tag_lc TEXT NOT NULL UNIQUE, status TEXT, category TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, created_date TEXT NOT NULL, deleted_at TEXT, search TEXT NOT NULL DEFAULT '', data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_list ON assets(is_deleted, created_date)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `INSERT INTO meta (key, value) VALUES ('version', 1) ON CONFLICT (key) DO NOTHING`
];
export function translate(sql) {
  let i = 0;
  return sql
    .replace(/json_extract\(data,'\$\.([A-Za-z0-9_]+)'\)/g, "(data::jsonb->>'$1')")
    .replace(/\browid\b/g, 'seq')
    .replace(/COUNT\(\*\) c\b/g, 'COUNT(*)::int c')
    .replace(/ IS NOT \?/g, ' IS DISTINCT FROM ?')
    .replace(/\?/g, () => '$' + (++i));
}
class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = translate(sql); this.args = args || []; }
  bind(...a) { const s = new Stmt(this.db, '', a); s.sql = this.sql; return s; }
  async first() { const r = await this.db.q(this.sql, this.args); return r[0] || null; }
  async all() { return { results: await this.db.q(this.sql, this.args) }; }
  async run() { await this.db.q(this.sql, this.args); return { meta: {} }; }
}
export function wrap(q, tx) {
  return { q, prepare(sql) { return new Stmt(this, sql, []); }, async batch(stmts) { await tx(stmts.map((s) => [s.sql, s.args])); return stmts.map(() => ({ meta: {} })); } };
}
async function connect() {
  if (process.env.LAB_DB === 'pglite') {            // used only for automated tests
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    const q = async (sql, args) => (await pg.query(sql, (args || []).map((x) => (x === undefined ? null : x)))).rows;
    const tx = async (list) => { await pg.transaction(async (t) => { for (const [s, a] of list) await t.query(s, a.map((x) => (x === undefined ? null : x))); }); };
    return { q, tx };
  }
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
  if (!url) throw new Error('No database is connected yet. In Vercel: Storage -> Create Database -> Neon (Postgres) -> Connect to this project, then redeploy.');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  const q = async (text, args) => sql.query(text, args || []);
  const tx = async (list) => { await sql.transaction(list.map(([s, a]) => sql.query(s, a))); };
  return { q, tx };
}
let ready;
export function getDb() {
  if (!ready) ready = (async () => {
    const { q, tx } = await connect();
    for (const s of SCHEMA) await q(s, []);
    return wrap(q, tx);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
