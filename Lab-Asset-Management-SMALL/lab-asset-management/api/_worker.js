/* =====================================================================================
 * 3DEXPERIENCE Lab Asset Management - SHARED SERVER (Cloudflare Worker + D1 database)
 * One database for every phone: a change made by any role is visible to every other role.
 * ===================================================================================== */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-expose-headers': 'x-data-version',
  'access-control-max-age': '86400'
};
const PBKDF2_ITER = 20000;            // kept low so it fits Cloudflare's free CPU limit; stored per user, can be raised later
const ENTITIES = ['Category', 'Location', 'MaintenanceLog', 'ScanHistory', 'Invitation', 'AssetChangeRequest',
  'UserActivityLog', 'BLEBeacon', 'BLEGateway', 'BLEGatewayReading'];
const ROLES = ['admin', 'asset_manager', 'asset_editor', 'user'];
const PRIV = ['admin', 'asset_manager', 'asset_editor'];
const ROLE_NAME = { admin: 'Admin', asset_manager: 'Asset Manager', asset_editor: 'Asset Editor', user: 'User' };
import { VISION_PROMPT, parseVision, GEMINI_PROMPT, parseGemini } from './_vision.js';
const enc = new TextEncoder();

/* ---------------------------------------------------------------- helpers */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const clone = (o) => JSON.parse(JSON.stringify(o));
function randHex(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(s) { const d = atob(s), o = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) o[i] = d.charCodeAt(i); return o; }
function safeEq(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function hashPw(pw, saltB64, iter) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter || PBKDF2_ITER }, key, 256);
  return { salt: b64(salt), hash: b64(bits), iter: iter || PBKDF2_ITER };
}
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function prettyName(email) { return String(email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function inviteCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint8Array(8));
  let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return s;
}
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
function cmp(a, b) {
  const an = a === undefined || a === null || a === '', bn = b === undefined || b === null || b === '';
  if (an && bn) return 0; if (an) return 1; if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
const Q = (env, sql, ...p) => env.DB.prepare(sql).bind(...p);
const rowsOf = async (env, sql, ...p) => (await Q(env, sql, ...p).all()).results || [];
const jsonList = (rows) => '[' + rows.map((r) => r.data).join(',') + ']';
const escLike = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

/* ---------------------------------------------------------------- e-mail */
async function sendMail(env, to, subject, text, html) {
  if (!env.BREVO_API_KEY) {
    throw new HttpError(503, 'The e-mail service is not set up yet. The administrator must add the BREVO_API_KEY (see README, step 5).');
  }
  const url = env.EMAIL_API_URL || 'https://api.brevo.com/v3/smtp/email';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: env.SENDER_NAME || '3DEXPERIENCE Lab Asset Management', email: env.SENDER_EMAIL },
        to: [{ email: to }], subject, textContent: text, htmlContent: html
      })
    });
  } catch (e) { throw new HttpError(502, 'Could not reach the e-mail service. Please try again.'); }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch (e) { }
    console.log('mail error', res.status, detail);
    throw new HttpError(502, 'The e-mail could not be sent (' + res.status + '). Check the sender address and API key in the server settings.');
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shell(title, inner) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">' +
    '<div style="background:#0f172a;color:#fff;padding:18px 22px"><div style="font-size:17px;font-weight:bold">3DEXPERIENCE Lab</div><div style="font-size:12px;opacity:.75">Asset Management</div></div>' +
    '<div style="padding:22px;color:#0f172a;font-size:15px;line-height:1.55"><h2 style="margin:0 0 12px;font-size:19px">' + esc(title) + '</h2>' + inner + '</div></div>';
}
function installBlock(ctx) {
  const base = appUrl(ctx), apk = ctx.env.ANDROID_APK_URL;
  return {
    text: '\n\nInstall the app:\n- Install page (Android & iPhone): ' + base + '/install' + (apk ? '\n- Android app download: ' + apk : '') +
      '\n- iPhone: open ' + base + ' in Safari, tap Share, then "Add to Home Screen".',
    html: '<p style="margin:18px 0 6px;font-weight:bold">Install the app</p><p style="margin:0 0 6px"><a href="' + esc(base + '/install') + '" style="color:#2563eb">' + esc(base + '/install') + '</a></p>' +
      (apk ? '<p style="margin:0 0 6px">Android app: <a href="' + esc(apk) + '" style="color:#2563eb">Download</a></p>' : '') +
      '<p style="margin:0;color:#475569;font-size:14px">iPhone: open the link in Safari, tap Share, then <b>Add to Home Screen</b>.</p>'
  };
}
function appUrl(ctx) { return (ctx.env.APP_URL || ctx.url.origin).replace(/\/$/, ''); }

/* ---------------------------------------------------------------- users & sessions */
const userFromRow = (r) => {
  if (!r) return null;
  const d = JSON.parse(r.data || '{}');
  return Object.assign({}, d, { id: r.id, email: r.email, role: r.role, is_active: r.is_active === 1, verified: r.verified === 1, created_date: r.created_date });
};
function publicUser(u) {
  return {
    id: u.id, email: u.email, full_name: u.full_name || '', role: u.role, is_active: u.is_active !== false,
    email_verified: u.verified !== false, verified: u.verified !== false, created_date: u.created_date,
    joined_via_invitation: !!u.joined_via_invitation, invitation_status: u.invitation_status || null,
    invitation_role: u.invitation_role || null, invitation_accepted_at: u.invitation_accepted_at || null
  };
}
async function saveUser(env, u) {
  const d = Object.assign({}, u); ['id', 'email', 'role', 'is_active', 'verified', 'created_date'].forEach((k) => delete d[k]);
  await Q(env, 'UPDATE users SET role=?, is_active=?, verified=?, data=? WHERE id=?', u.role, u.is_active === false ? 0 : 1, u.verified ? 1 : 0, JSON.stringify(d), u.id).run();
}
async function userByEmail(env, email) {
  return userFromRow(await Q(env, 'SELECT * FROM users WHERE email=?', email).first());
}
async function newSession(env, userId) {
  const token = randHex(32);
  await Q(env, 'INSERT INTO sessions (token,user_id,created) VALUES (?,?,?)', token, userId, Date.now()).run();
  return token;
}
async function authUser(ctx) {
  const h = ctx.request.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'Not authenticated');
  const r = await Q(ctx.env, 'SELECT u.* , s.created AS s_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', token).first();
  if (!r || Date.now() - r.s_created > 180 * 864e5) throw new HttpError(401, 'Not authenticated');
  const u = userFromRow(r);
  if (!u.verified) throw new HttpError(401, 'Not authenticated');
  if (!u.is_active) throw new HttpError(403, 'Your access has been revoked. Please contact an administrator.');
  return u;
}
const requireRole = (user, roles) => { if (!user || roles.indexOf(user.role) < 0) throw new HttpError(403, 'You do not have permission to perform this action.'); };
const activeAdminCount = async (env) => (await Q(env, "SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1 AND verified=1").first()).c;

/* ---------------------------------------------------------------- auth endpoints */
async function issueOtp(ctx, email) {
  const env = ctx.env;
  const prev = await Q(env, "SELECT sent_at FROM codes WHERE email=? AND purpose='verify'", email).first();
  if (prev && Date.now() - prev.sent_at < 30000) throw new HttpError(429, 'Please wait 30 seconds before asking for another code.');
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const salt = randHex(8);
  const hash = await sha256hex(email + '|' + code + '|' + salt);
  await sendMail(env, email, 'Your verification code: ' + code,
    'Your 3DEXPERIENCE Lab Asset Management verification code is ' + code + '\n\nIt expires in 10 minutes. If you did not sign up, ignore this email.',
    shell('Verify your email', '<p>Enter this code in the app to finish creating your account:</p>' +
      '<p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#f1f5f9;border-radius:8px;text-align:center;padding:14px 0;margin:16px 0">' + code + '</p>' +
      '<p style="color:#64748b;font-size:13px">The code expires in 10 minutes. If you did not sign up, you can ignore this email.</p>'));
  await Q(env, "INSERT INTO codes (email,purpose,code_hash,salt,expires,attempts,sent_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,expires=excluded.expires,attempts=0,sent_at=excluded.sent_at",
    email, 'verify', hash, salt, Date.now() + 10 * 60000, Date.now()).run();
}
const isPlaceholderAdmin = (e) => !e || e === 'you@example.com';
async function mayJoin(env, email) {
  const adminEmail = normEmail(env.ADMIN_EMAIL);
  if (!isPlaceholderAdmin(adminEmail) && email === adminEmail) return true;
  if (await pendingInviteFor(env, email)) return true;
  if (isPlaceholderAdmin(adminEmail)) { const a = await Q(env, "SELECT COUNT(*) c FROM users WHERE role='admin' AND verified=1").first(); if (a.c === 0) return true; }
  return false;
}
const NOT_INVITED = 'This email has not been invited. Only people invited by the administrator can create an account. Ask the admin to send you an invitation.';
async function pendingInviteFor(env, email) {
  return Q(env, "SELECT * FROM invitations WHERE email=? AND status='pending' ORDER BY created_date DESC", email).first();
}
const AUTH = {
  async register(ctx, b) {
    const env = ctx.env, email = normEmail(b.email), pw = String(b.password || '');
    if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (pw.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    if (!(await mayJoin(env, email))) throw new HttpError(403, NOT_INVITED);
    const existing = await userByEmail(env, email);
    if (existing && existing.verified) throw new HttpError(409, 'An account with this email already exists. Please log in.');
    const code = normCode(b.invite_token);
    if (code) {
      const inv = await Q(env, "SELECT * FROM invitations WHERE code=? AND status='pending'", code).first();
      if (inv && inv.email !== email) throw new HttpError(400, 'This invitation was sent to a different email address. Use the email it was sent to.');
    }
    const ph = await hashPw(pw);
    const data = { full_name: prettyName(email), password_hash: ph.hash, password_salt: ph.salt, password_iter: ph.iter };
    if (existing) {
      await Q(env, 'UPDATE users SET data=? WHERE id=?', JSON.stringify(Object.assign({}, JSON.parse((await Q(env, 'SELECT data FROM users WHERE id=?', existing.id).first()).data), data)), existing.id).run();
    } else {
      await Q(env, "INSERT INTO users (id,email,role,is_active,verified,created_date,data) VALUES (?,?,'user',1,0,?,?)", uuid(), email, nowIso(), JSON.stringify(data)).run();
    }
    await issueOtp(ctx, email);
    ctx.mutated = true;
    return { message: 'We emailed you a six-digit code.', email, requires_verification: true };
  },
  async 'resend-otp'(ctx, b) {
    const email = normEmail(b.email), u = await userByEmail(ctx.env, email);
    if (u && !u.verified) await issueOtp(ctx, email);
    return { message: 'If that email is waiting for verification, a new code was sent.' };
  },
  async 'verify-otp'(ctx, b) {
    const env = ctx.env, email = normEmail(b.email), code = String(b.otpCode || '').trim();
    const row = await Q(env, "SELECT * FROM codes WHERE email=? AND purpose='verify'", email).first();
    const bad = new HttpError(400, 'Invalid or expired verification code.');
    if (!row || Date.now() > row.expires || row.attempts >= 5) throw bad;
    const ok = safeEq(await sha256hex(email + '|' + code + '|' + row.salt), row.code_hash);
    if (!ok) { await Q(env, "UPDATE codes SET attempts=attempts+1 WHERE email=? AND purpose='verify'", email).run(); throw bad; }
    await Q(env, "DELETE FROM codes WHERE email=? AND purpose='verify'", email).run();
    const u = await userByEmail(env, email);
    if (!u) throw bad;
    if (!u.verified && !(await mayJoin(env, email))) throw new HttpError(403, NOT_INVITED);
    if (!u.verified) {
      const admins = await Q(env, "SELECT COUNT(*) c FROM users WHERE role='admin' AND verified=1").first();
      const adminEmail = normEmail(env.ADMIN_EMAIL);
      const inv = await pendingInviteFor(env, email);
      if (adminEmail && adminEmail !== 'you@example.com' && email === adminEmail) u.role = 'admin';
      else if ((!adminEmail || adminEmail === 'you@example.com') && admins.c === 0) u.role = 'admin';
      else if (inv) u.role = inv.role;
      else u.role = 'user';
      if (inv && u.role !== 'admin') {
        u.joined_via_invitation = true; u.invitation_status = 'accepted'; u.invitation_role = inv.role; u.invitation_accepted_at = nowIso();
      }
      if (inv) await Q(env, "UPDATE invitations SET status='accepted', accepted_at=? WHERE id=?", nowIso(), inv.id).run();
      u.verified = true;
      await saveUser(env, u);
      ctx.mutated = true;
    }
    return { access_token: await newSession(env, u.id), token_type: 'bearer', user: publicUser(u) };
  },
  async login(ctx, b) {
    const env = ctx.env, email = normEmail(b.email), u = await userByEmail(env, email);
    const bad = new HttpError(401, 'Invalid email or password');
    if (!u) { await hashPw('x'); throw bad; }
    if (u.locked_until && Date.now() < u.locked_until) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const h = await hashPw(String(b.password || ''), u.password_salt, u.password_iter);
    if (!safeEq(h.hash, u.password_hash || '')) {
      u.fails = (u.fails || 0) + 1;
      if (u.fails >= 8) { u.locked_until = Date.now() + 15 * 60000; u.fails = 0; }
      await saveUser(env, u); throw bad;
    }
    if (!u.verified) throw new HttpError(403, 'Please verify your email first. Register again with the same email to get a new code.');
    if (!u.is_active) throw new HttpError(403, 'Your access has been revoked. Please contact an administrator.');
    if (u.fails || u.locked_until) { u.fails = 0; delete u.locked_until; await saveUser(env, u); }
    return { access_token: await newSession(env, u.id), token_type: 'bearer', user: publicUser(u) };
  },
  async me(ctx) { return publicUser(await authUser(ctx)); },
  async 'reset-password-request'(ctx, b) {
    const email = normEmail(b.email), u = await userByEmail(ctx.env, email);
    if (!u || !u.verified) return {};
    const token = randHex(24);
    await Q(ctx.env, 'INSERT INTO resets (token,user_id,expires) VALUES (?,?,?)', token, u.id, Date.now() + 3600e3).run();
    return { reset_token: token };
  },
  async 'reset-password'(ctx, b) {
    const env = ctx.env, t = await Q(env, 'SELECT * FROM resets WHERE token=?', String(b.resetToken || '')).first();
    if (!t || Date.now() > t.expires) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
    const pw = String(b.newPassword || '');
    if (pw.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
    const u = userFromRow(await Q(env, 'SELECT * FROM users WHERE id=?', t.user_id).first());
    if (!u) throw new HttpError(400, 'Account not found.');
    const ph = await hashPw(pw);
    u.password_hash = ph.hash; u.password_salt = ph.salt; u.password_iter = ph.iter; u.fails = 0; delete u.locked_until;
    await saveUser(env, u);
    await Q(env, 'DELETE FROM resets WHERE token=?', t.token).run();
    await Q(env, 'DELETE FROM sessions WHERE user_id=?', u.id).run();
    ctx.mutated = true;
    return { message: 'Password updated.' };
  }
};

/* ---------------------------------------------------------------- generic records (categories, locations, logs, scans ...) */
const SORT_OK = /^-?[a-zA-Z_][a-zA-Z0-9_]*$/;
async function entityRoute(ctx, method, parts, body, user) {
  const env = ctx.env, name = decodeURIComponent(parts[0] || '');
  if (ENTITIES.indexOf(name) < 0) throw new HttpError(404, 'Unknown entity: ' + name);
  const rest = parts.slice(1).map(decodeURIComponent);
  const isFilter = method === 'POST' && rest[0] === 'filter';
  if (method !== 'GET' && !isFilter && user.role === 'user') throw new HttpError(403, 'You have view-only access.');
  const order = (sort) => {
    sort = sort || '-created_date';
    if (!SORT_OK.test(sort)) sort = '-created_date';
    const desc = sort[0] === '-', f = desc ? sort.slice(1) : sort;
    const col = (f === 'created_date') ? 'created_date' : "json_extract(data,'$." + f + "')";
    return ' ORDER BY ' + col + (desc ? ' DESC' : ' ASC') + ', rowid ' + (desc ? 'DESC' : 'ASC');
  };
  const lim = (l) => Math.max(1, Math.min(Number(l) || 500, 2000));
  if ((method === 'GET' && rest.length === 0) || isFilter) {
    const conds = ['store=?'], params = [name];
    const filter = isFilter ? (body.filter || {}) : {};
    Object.keys(filter).forEach((k) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) return;
      const v = filter[k], path = "json_extract(data,'$." + k + "')";
      if (v === null) conds.push(path + ' IS NULL');
      else if (v && typeof v === 'object' && Array.isArray(v.$in)) { conds.push(path + ' IN (' + v.$in.map(() => '?').join(',') + ')'); params.push(...v.$in); }
      else if (v && typeof v === 'object' && v.$ne !== undefined) { conds.push(path + ' IS NOT ?'); params.push(v.$ne); }
      else { conds.push(path + '=?'); params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v); }
    });
    const rows = await rowsOf(env, 'SELECT data FROM records WHERE ' + conds.join(' AND ') + order(body.sort) + ' LIMIT ' + lim(body.limit), ...params);
    return { raw: jsonList(rows) };
  }
  if (method === 'POST' && rest.length === 0) {
    const rec = Object.assign({}, body, { id: uuid(), created_date: nowIso(), updated_date: nowIso(), created_by: user.email });
    await Q(env, 'INSERT INTO records (store,id,created_date,data) VALUES (?,?,?,?)', name, rec.id, rec.created_date, JSON.stringify(rec)).run();
    ctx.mutated = true; return rec;
  }
  const id = rest[0], row = await Q(env, 'SELECT data FROM records WHERE store=? AND id=?', name, id).first();
  if (!row) throw new HttpError(404, name + ' not found');
  if (method === 'GET') return { raw: row.data };
  if (method === 'PATCH' || method === 'PUT') {
    const next = Object.assign({}, JSON.parse(row.data), body, { id, updated_date: nowIso() });
    await Q(env, 'UPDATE records SET data=? WHERE store=? AND id=?', JSON.stringify(next), name, id).run();
    ctx.mutated = true; return next;
  }
  if (method === 'DELETE') { await Q(env, 'DELETE FROM records WHERE store=? AND id=?', name, id).run(); ctx.mutated = true; return { success: true }; }
  throw new HttpError(405, 'Method not allowed');
}

/* ---------------------------------------------------------------- assets */
const ALIAS_PAIRS = [['descr', 'name'], ['acquisition_date', 'purchase_date'], ['in_service_date', 'start_date'],
  ['out_of_service_date', 'end_date'], ['serial_identification_number', 'serial_number'], ['asset_cost', 'cost']];
const NUMERIC = ['asset_cost', 'cost', 'monthly_depreciation', 'ytd_depreciation', 'accumulated_depreciation', 'net_book_value', 'maintenance_cost'];
const SEARCH_KEYS = ['name', 'descr', 'asset_tag', 'asset_tag_number', 'asset_identification_number', 'serial_identification_number',
  'serial_number', 'brand', 'model', 'type', 'category', 'location', 'department', 'supplier', 'asset_custodian', 'assigned_to', 'notes'];
function toNum(v) {
  if (v === '' || v === undefined || v === null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim(), neg = /^\(.*\)$/.test(s), n = Number(s.replace(/[^0-9.\-]/g, ''));
  if (s === '' || isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}
function applyAliases(next, changes) {
  NUMERIC.forEach((k) => { if (k in next) next[k] = toNum(next[k]); });
  ALIAS_PAIRS.forEach((p) => { if (p[0] in changes) next[p[1]] = next[p[0]]; else if (p[1] in changes) next[p[0]] = next[p[1]]; });
  if (next.descr && !next.name) next.name = next.descr;
  if (next.name && !next.descr) next.descr = next.name;
  return next;
}
const searchText = (a) => SEARCH_KEYS.map((k) => (a[k] == null ? '' : String(a[k]))).join(' ').toLowerCase();
const ASSET_UPSERT = 'INSERT INTO assets (id,tag_lc,status,category,is_deleted,created_date,deleted_at,search,data) VALUES (?,?,?,?,?,?,?,?,?) ' +
  'ON CONFLICT(id) DO UPDATE SET tag_lc=excluded.tag_lc,status=excluded.status,category=excluded.category,is_deleted=excluded.is_deleted,deleted_at=excluded.deleted_at,search=excluded.search,data=excluded.data';
const assetStmt = (env, a, ins) => Q(env, ins || ASSET_UPSERT, a.id, String(a.asset_tag || '').trim().toLowerCase(), a.status || '', a.category || '', a.is_deleted ? 1 : 0, a.created_date, a.deleted_at || null, searchText(a), JSON.stringify(a));
async function loadAsset(env, id) { const r = await Q(env, 'SELECT data FROM assets WHERE id=?', id).first(); return r ? JSON.parse(r.data) : null; }
async function tagTaken(env, tag, exceptId) {
  const r = await Q(env, 'SELECT id FROM assets WHERE tag_lc=? AND id<>?', String(tag || '').trim().toLowerCase(), exceptId || '').first();
  return !!r;
}
function genTag() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint8Array(6));
  let s = ''; for (let i = 0; i < 6; i++) s += A[b[i] % A.length];
  return '3DXP-' + s;
}
async function catalogStatements(env, assets, user) {
  const have = { Category: new Set(), Location: new Set() };
  for (const st of ['Category', 'Location']) {
    (await rowsOf(env, "SELECT lower(json_extract(data,'$.name')) n FROM records WHERE store=?", st)).forEach((r) => have[st].add(String(r.n || '').trim()));
  }
  const out = [], ts = nowIso();
  assets.forEach((a) => {
    [['Category', 'category'], ['Location', 'location']].forEach(([st, f]) => {
      const v = String(a[f] == null ? '' : a[f]).trim(), low = v.toLowerCase();
      if (!v || have[st].has(low)) return;
      have[st].add(low);
      const rec = { id: uuid(), name: v, description: 'Added automatically from asset data', created_date: ts, updated_date: ts, created_by: user.email };
      if (st === 'Location') { rec.building = ''; rec.floor = ''; rec.room = ''; }
      out.push(Q(env, 'INSERT INTO records (store,id,created_date,data) VALUES (?,?,?,?)', st, rec.id, ts, JSON.stringify(rec)));
    });
  });
  return out;
}
async function createAssetRecord(env, input, user) {
  const inp = clone(input || {}); delete inp.id; delete inp.is_deleted;
  const next = applyAliases(Object.assign({ status: 'available', condition: 'good' }, inp), inp);
  if (!next.name) throw new HttpError(400, 'Asset description is required.');
  if (!next.asset_tag) { do { next.asset_tag = genTag(); } while (await tagTaken(env, next.asset_tag)); }
  else if (await tagTaken(env, next.asset_tag)) throw new HttpError(409, 'Asset tag "' + next.asset_tag + '" is already in use.');
  next.id = uuid(); next.created_date = nowIso(); next.updated_date = nowIso(); next.created_by = user.email; next.is_deleted = false;
  await env.DB.batch([assetStmt(env, next), ...(await catalogStatements(env, [next], user))]);
  return next;
}
async function updateAssetRecord(env, id, changes, user) {
  const cur = await loadAsset(env, id);
  if (!cur) throw new HttpError(404, 'Asset not found');
  const ch = clone(changes || {});
  ['id', 'asset_id', 'created_date', 'created_by', 'is_deleted'].forEach((k) => delete ch[k]);
  if (ch.asset_tag && await tagTaken(env, ch.asset_tag, id)) throw new HttpError(409, 'Asset tag "' + ch.asset_tag + '" is already in use.');
  const next = applyAliases(Object.assign({}, cur, ch), ch);
  next.updated_date = nowIso(); next.updated_by = user.email;
  await env.DB.batch([assetStmt(env, next), ...(await catalogStatements(env, [next], user))]);
  return next;
}

/* ---------------------------------------------------------------- import mapping */
const FIELD_ALIASES = (() => {
  const m = {}; const add = (f, names) => names.forEach((n) => { m[n] = f; });
  add('descr', ['descr', 'description', 'assetdescription', 'descriptionofasset', 'itemdescription', 'assetdesc']);
  add('name', ['name', 'assetname', 'itemname', 'title', 'item', 'equipment', 'equipmentname']);
  add('asset_tag', ['assettag', 'tag', 'assettagid', 'tagid', 'barcode']);
  add('asset_tag_number', ['assettagnumber', 'tagnumber', 'tagno', 'assettagno']);
  add('asset_identification_number', ['assetidentificationnumber', 'assetid', 'assetidno', 'assetnumber', 'assetno', 'assetidentification']);
  add('old_asset_identification_number', ['oldassetidentificationnumber', 'oldassetid', 'oldassetnumber', 'oldassetno']);
  add('serial_identification_number', ['serialidentificationnumber', 'serialnumber', 'serialno', 'serial', 'slno']);
  add('category', ['category', 'assetcategory', 'type', 'assettype', 'class', 'assetclass', 'group']);
  add('location', ['location', 'assetlocation', 'room', 'site', 'place', 'lab']);
  add('status', ['status', 'assetstatus']); add('condition', ['condition', 'assetcondition']);
  add('notes', ['notes', 'remarks', 'remark', 'comment', 'comments']);
  add('am_unit', ['amunit']); add('gl_unit', ['glunit']);
  add('parent_asset_id', ['parentassetid', 'parentasset', 'parentassetidentification']);
  add('acquisition_date', ['acquisitiondate', 'purchasedate', 'dateofpurchase', 'dateacquired', 'dateofacquisition', 'acquired']);
  add('asset_cost', ['assetcost', 'cost', 'purchasecost', 'price', 'originalcost', 'acquisitioncost', 'purchaseprice', 'amount']);
  add('monthly_depreciation', ['monthlydepreciation']); add('ytd_depreciation', ['ytddepreciation', 'yeartodatedepreciation']);
  add('accumulated_depreciation', ['accumulateddepreciation', 'accdepreciation']);
  add('net_book_value', ['netbookvalue', 'nbv', 'bookvalue']);
  add('asset_book_name', ['assetbookname', 'bookname']); add('asset_book_code', ['assetbookcode', 'bookcode']);
  add('asset_profile_identification', ['assetprofileidentification', 'assetprofile']);
  add('asset_useful_life', ['assetusefullife', 'usefullife', 'life']);
  add('general_ledger_account', ['generalledgeraccount', 'glaccount', 'ledgeraccount']);
  add('department', ['department', 'dept']); add('operating_unit', ['operatingunit']);
  add('asset_custodian', ['assetcustodian', 'custodian', 'assignedto', 'owner', 'user', 'incharge']);
  add('in_service_date', ['inservicedate', 'dateinservice', 'startdate', 'commissioningdate']);
  add('out_of_service_date', ['outofservicedate', 'enddate']); add('last_audit_date', ['lastauditdate', 'auditdate']);
  add('supplier', ['supplier', 'vendor', 'suppliername', 'vendorname']);
  add('purchase_order_number', ['purchaseordernumber', 'ponumber', 'pono', 'po', 'purchaseorder']);
  add('accounting_voucher_number', ['accountingvouchernumber', 'voucher', 'vouchernumber']);
  add('address_line_1', ['addressline1', 'address1', 'address']); add('address_line_2', ['addressline2', 'address2']);
  add('address_line_3', ['addressline3', 'address3']); add('address_line_4', ['addressline4', 'address4']);
  add('city', ['city', 'town']); add('county', ['county', 'district']); add('state', ['state', 'province']);
  add('postal_code', ['postalcode', 'zip', 'zipcode', 'pincode', 'postcode']); add('country', ['country']);
  add('brand', ['brand', 'make', 'manufacturer']); add('model', ['model', 'modelnumber', 'modelno']);
  // exact labels used by the Add Asset form
  add('am_unit', ['assetmanagementunit', 'amunit']); add('gl_unit', ['generalledgerunit', 'glunit']);
  add('old_asset_identification_number', ['previousoldassetidentificationnumber', 'previousassetidentificationnumber', 'oldassetidentificationnumber']);
  add('category', ['assetcategory']); add('descr', ['description', 'assetdescription']); add('asset_tag', ['assettagrfid', 'assettagrfidno', 'rfid', 'assettag']);
  add('ytd_depreciation', ['yeartodatedepreciation', 'ytddepreciation']); add('in_service_date', ['inservicedate']); add('location', ['assetlocation']);
  add('supplier', ['suppliervendor', 'supplier', 'vendor']); add('county', ['countydistrict', 'county', 'district']); add('postal_code', ['postalzippincode', 'postalcode', 'zipcode', 'pincode']);
  add('asset_cost', ['assetcost']); add('serial_identification_number', ['serialidentificationnumber']);
  return m;
})();
const DATE_FIELDS = ['acquisition_date', 'in_service_date', 'out_of_service_date', 'last_audit_date'];
const NUM_FIELDS = ['asset_cost', 'monthly_depreciation', 'ytd_depreciation', 'accumulated_depreciation', 'net_book_value'];
function normStatus(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/^(inuse|active|assigned|deployed|working)$/.test(s)) return 'in_use';
  if (/^(inrepair|repair|underrepair|maintenance|undermaintenance|servicing)$/.test(s)) return 'in_repair';
  if (/^(relocated|moved|transferred)$/.test(s)) return 'relocated';
  if (/^(broken|damaged|faulty|defective|notworking)$/.test(s)) return 'broken';
  if (/^(retired|disposed|scrapped|decommissioned|writtenoff|obsolete)$/.test(s)) return 'retired';
  return 'available';
}
function normCondition(v) {
  const s = String(v || '').toLowerCase().trim();
  return ['excellent', 'good', 'fair', 'poor', 'broken'].indexOf(s) >= 0 ? s : (s === 'new' ? 'excellent' : s === 'bad' ? 'poor' : 'good');
}
function isoDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dm = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);           // Indian style: day first
  if (dm) { const d = +dm[1], m = +dm[2]; if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return dm[3] + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  const t = new Date(s);
  return isNaN(t) ? s : t.toISOString().slice(0, 10);
}
const ALIAS_KEYS = Object.keys(FIELD_ALIASES).sort((a, b) => b.length - a.length);
function headerField(h) {
  const key = String(h).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/_\d+$/, '').replace(/[^a-z0-9]/g, '');
  if (FIELD_ALIASES[key]) return FIELD_ALIASES[key];
  const k = ALIAS_KEYS.find((a) => a.length >= 7 && key.length > a.length && key.indexOf(a) >= 0);
  return k ? FIELD_ALIASES[k] : undefined;
}
function mapRecord(raw) {
  const rec = {};
  Object.keys(raw).forEach((h) => {
    const f = headerField(h);
    let v = raw[h];
    if (!f || v === '' || v === null || v === undefined) return;
    if (rec[f] !== undefined && rec[f] !== '') return;
    if (DATE_FIELDS.indexOf(f) >= 0) v = isoDate(v);
    else if (NUM_FIELDS.indexOf(f) >= 0) v = toNum(v);
    else v = String(v).trim();
    rec[f] = v;
  });
  rec.original_data = raw;
  return rec;
}

/* ---------------------------------------------------------------- functions */
const FN = {};
FN.getAssets = async (ctx, p, user) => {
  const env = ctx.env; p = p || {};
  if (p.asset_id) {
    const a = await Q(env, 'SELECT data FROM assets WHERE id=?', p.asset_id).first();
    if (!a) throw new HttpError(404, 'Asset not found');
    return { raw: '{"asset":' + a.data + ',"role":"' + user.role + '"}' };
  }
  if (p.deleted_only) {
    requireRole(user, ['admin', 'asset_manager']);
    const rows = await rowsOf(env, 'SELECT data FROM assets WHERE is_deleted=1 ORDER BY deleted_at DESC, rowid DESC');
    return { raw: '{"assets":' + jsonList(rows) + ',"total":' + rows.length + ',"role":"' + user.role + '"}' };
  }
  const conds = ['is_deleted=0'], params = [];
  if (p.status && p.status !== 'all') { conds.push('status=?'); params.push(p.status); }
  if (p.category && p.category !== 'all') { conds.push('category=?'); params.push(p.category); }
  if (p.search && String(p.search).trim()) {
    String(p.search).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).forEach((t) => { conds.push("search LIKE ? ESCAPE '\\'"); params.push('%' + escLike(t) + '%'); });
  }
  const where = ' WHERE ' + conds.join(' AND '), ord = ' ORDER BY created_date DESC, rowid DESC';
  if (p.page) {
    const size = Math.max(1, Math.min(Number(p.page_size) || 50, 500));
    const total = (await Q(env, 'SELECT COUNT(*) c FROM assets' + where, ...params).first()).c;
    const pages = Math.max(1, Math.ceil(total / size)), page = Math.min(Math.max(1, Number(p.page) || 1), pages);
    const rows = await rowsOf(env, 'SELECT data FROM assets' + where + ord + ' LIMIT ? OFFSET ?', ...params, size, (page - 1) * size);
    return { raw: '{"assets":' + jsonList(rows) + ',"total":' + total + ',"page":' + page + ',"page_size":' + size + ',"total_pages":' + pages + ',"role":"' + user.role + '"}' };
  }
  const rows = await rowsOf(env, 'SELECT data FROM assets' + where + ord, ...params);
  return { raw: '{"assets":' + jsonList(rows) + ',"total":' + rows.length + ',"role":"' + user.role + '"}' };
};
FN.getScannedAsset = async (ctx, p, user) => {
  const env = ctx.env, a = await Q(env, 'SELECT data FROM assets WHERE tag_lc=? AND is_deleted=0', String(p.asset_tag || '').trim().toLowerCase()).first();
  if (!a) throw new HttpError(404, 'No asset found with tag "' + p.asset_tag + '".');
  let logs = [];
  if (PRIV.indexOf(user.role) >= 0) {
    const id = JSON.parse(a.data).id;
    logs = await rowsOf(env, "SELECT data FROM records WHERE store='MaintenanceLog' AND json_extract(data,'$.asset_id')=? ORDER BY created_date DESC", id);
  }
  return { raw: '{"asset":' + a.data + ',"maintenanceLogs":' + jsonList(logs) + ',"role":"' + user.role + '"}' };
};
FN.getPublicAsset = async (ctx, p) => {
  const a = await Q(ctx.env, 'SELECT data FROM assets WHERE tag_lc=? AND is_deleted=0', String(p.asset_tag || '').trim().toLowerCase()).first();
  if (!a) throw new HttpError(404, 'No asset found with tag "' + p.asset_tag + '".');
  const full = JSON.parse(a.data), o = {};
  ['id', 'name', 'status', 'condition', 'asset_tag', 'category', 'type', 'brand', 'model', 'location'].forEach((k) => { o[k] = full[k]; });
  return { asset: o, maintenanceLogs: [] };
};
FN.createAsset = async (ctx, p, user) => { requireRole(user, ['admin', 'asset_manager']); ctx.mutated = true; return { asset: await createAssetRecord(ctx.env, p, user) }; };
FN.updateAsset = async (ctx, p, user) => {
  requireRole(user, PRIV);
  const ch = Object.assign({}, p); delete ch.asset_id; ctx.mutated = true;
  return { asset: await updateAssetRecord(ctx.env, p.asset_id, ch, user) };
};
FN.softDeleteAsset = async (ctx, p, user) => {
  requireRole(user, ['admin', 'asset_manager']);
  const a = await loadAsset(ctx.env, p.asset_id);
  if (!a) throw new HttpError(404, 'Asset not found');
  a.is_deleted = true; a.deleted_at = nowIso(); a.deleted_by = user.email; a.updated_date = nowIso();
  await assetStmt(ctx.env, a).run(); ctx.mutated = true; return { success: true };
};
FN.recoverAsset = async (ctx, p, user) => {
  requireRole(user, ['admin', 'asset_manager']);
  const a = await loadAsset(ctx.env, p.asset_id);
  if (!a) throw new HttpError(404, 'Asset not found');
  a.is_deleted = false; delete a.deleted_at; delete a.deleted_by; a.updated_date = nowIso();
  await assetStmt(ctx.env, a).run(); ctx.mutated = true; return { success: true, asset: a };
};
FN.submitAssetChange = async (ctx, p, user) => {
  requireRole(user, ['asset_editor']);
  const env = ctx.env, action = p.action === 'update' ? 'update' : 'create', changes = clone(p.changes || {});
  let asset = null;
  if (action === 'update') { asset = await loadAsset(env, p.asset_id); if (!asset) throw new HttpError(404, 'Asset not found'); }
  else if (!(changes.name || changes.descr)) throw new HttpError(400, 'Asset description is required.');
  const req = {
    id: uuid(), action, asset_id: asset ? asset.id : null, asset_name: asset ? asset.name : (changes.name || changes.descr),
    asset_tag: asset ? asset.asset_tag : changes.asset_tag, changes, status: 'pending', requested_by: user.email,
    requested_by_name: user.full_name || user.email, created_date: nowIso(), updated_date: nowIso()
  };
  await Q(env, "INSERT INTO records (store,id,created_date,data) VALUES ('AssetChangeRequest',?,?,?)", req.id, req.created_date, JSON.stringify(req)).run();
  ctx.mutated = true; return { request: req };
};
FN.getAssetChangeRequests = async (ctx, p, user) => {
  p = p || {};
  const conds = ["store='AssetChangeRequest'"], params = [];
  if (user.role === 'admin' || user.role === 'asset_manager') { /* all */ }
  else if (user.role === 'asset_editor') { conds.push("json_extract(data,'$.requested_by')=?"); params.push(user.email); }
  else throw new HttpError(403, 'You do not have permission to view change requests.');
  if (p.status) { conds.push("json_extract(data,'$.status')=?"); params.push(p.status); }
  const rows = await rowsOf(ctx.env, 'SELECT data FROM records WHERE ' + conds.join(' AND ') + ' ORDER BY created_date DESC, rowid DESC LIMIT 500', ...params);
  return { raw: '{"requests":' + jsonList(rows) + '}' };
};
FN.reviewAssetChange = async (ctx, p, user) => {
  requireRole(user, ['admin', 'asset_manager']);
  const env = ctx.env, row = await Q(env, "SELECT data FROM records WHERE store='AssetChangeRequest' AND id=?", p.request_id).first();
  if (!row) throw new HttpError(404, 'Change request not found');
  const r = JSON.parse(row.data);
  if (r.status !== 'pending') throw new HttpError(400, 'This request has already been reviewed.');
  const approve = p.decision === 'approve';
  if (approve) {
    const requester = userFromRow(await Q(env, 'SELECT * FROM users WHERE email=?', r.requested_by).first()) || user;
    if (r.action === 'create') await createAssetRecord(env, r.changes, requester);
    else await updateAssetRecord(env, r.asset_id, r.changes, requester);
  }
  r.status = approve ? 'approved' : 'rejected'; r.reviewed_by = user.email; r.reviewed_at = nowIso(); r.review_comment = p.comment || ''; r.updated_date = nowIso();
  await Q(env, "UPDATE records SET data=? WHERE store='AssetChangeRequest' AND id=?", JSON.stringify(r), r.id).run();
  ctx.mutated = true; return { request: r };
};
FN.saveScan = async (ctx, p, user) => {
  requireRole(user, PRIV);
  if (!p.location) throw new HttpError(400, 'Select a location first.');
  const results = Array.isArray(p.results) ? p.results.slice(0, 200).map((r) => ({ name: String(r.name || '').slice(0, 80), quantity: Number(r.quantity) || 0, confidence: Number(r.confidence) || 0 })) : [];
  const d = new Date();
  const scan = {
    id: uuid(), location: String(p.location), source: String(p.source || 'upload'), scanned_at: p.scanned_at || d.toISOString(),
    scan_date: p.scan_date || d.toISOString().slice(0, 10), total_objects: results.reduce((s, r) => s + r.quantity, 0), results,
    image_url: typeof p.image_url === 'string' && p.image_url.length < 400000 ? p.image_url : '', scanned_by: user.email,
    created_date: d.toISOString(), updated_date: d.toISOString(), engine: p.engine === 'ai-vision' ? 'ai-vision' : 'on-device'
  };
  await Q(ctx.env, "INSERT INTO records (store,id,created_date,data) VALUES ('ScanHistory',?,?,?)", scan.id, scan.created_date, JSON.stringify(scan)).run();
  ctx.mutated = true; return { scan };
};
FN.importAssets = async (ctx, p, user) => {
  requireRole(user, ['admin', 'asset_manager']);
  const env = ctx.env, rows = Array.isArray(p.rows) ? p.rows : [];
  if (rows.length > 80) throw new HttpError(400, 'Send at most 80 rows per request.');
  const mapped = rows.map((r) => mapRecord(r.originalData || {}));
  const tags = mapped.map((m) => String(m.asset_tag || m.asset_tag_number || '').trim().toLowerCase()).filter(Boolean);
  const existing = new Set();
  if (tags.length) (await rowsOf(env, 'SELECT tag_lc FROM assets WHERE tag_lc IN (' + tags.map(() => '?').join(',') + ')', ...tags)).forEach((r) => existing.add(r.tag_lc));
  const seen = new Set(), created = [], skipped = [];
  mapped.forEach((rec) => {
    let tag = String(rec.asset_tag || rec.asset_tag_number || '').trim();
    if (tag) {
      const low = tag.toLowerCase();
      if (existing.has(low) || seen.has(low)) { skipped.push(tag); return; }
      seen.add(low);
    } else { do { tag = genTag(); } while (seen.has(tag.toLowerCase())); seen.add(tag.toLowerCase()); }
    rec.asset_tag = tag;
    rec.status = rec.status ? normStatus(rec.status) : 'available';
    rec.condition = normCondition(rec.condition);
    const next = applyAliases(rec, rec);
    if (!next.name) next.name = next.descr = next.asset_tag;
    next.id = uuid(); next.created_date = nowIso(); next.updated_date = nowIso(); next.created_by = user.email; next.is_deleted = false;
    created.push(next);
  });
  const cat = await catalogStatements(env, created, user);
  const stmts = created.map((a) => assetStmt(env, a, ASSET_UPSERT)).concat(cat);
  if (stmts.length) await env.DB.batch(stmts);
  ctx.mutated = true;
  return { imported: created.length, skipped: skipped.length, skipped_tags: skipped.slice(0, 50), new_catalog_entries: cat.length };
};

FN.analyzeImage = async (ctx, p, user) => {
  requireRole(user, PRIV);
  const env = ctx.env;
  if (!env.AI && !env.GEMINI_API_KEY) return { results: null, reason: 'ai-not-configured' };
  const m = String(p.image || '').match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m || m[1].length > 700000) throw new HttpError(400, 'Send a JPEG/PNG image under 500 KB.');
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_MODEL || 'gemini-2.0-flash', mime = /^data:image\/png/.test(p.image) ? 'image/png' : 'image/jpeg';
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(env.GEMINI_API_KEY), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: GEMINI_PROMPT }, { inline_data: { mime_type: mime, data: m[1] } }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
      });
      if (!r.ok) throw new Error('gemini ' + r.status);
      const j = await r.json();
      const txt = ((j.candidates || [])[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map((x) => x.text || '').join('');
      return { results: parseGemini(txt), engine: 'ai-vision' };
    } catch (e) { console.log('gemini error', String(e && e.message || e).slice(0, 200)); if (!env.AI) return { results: null, reason: 'ai-error' }; }
  }
  try {
    const bin = atob(m[1]), bytes = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const r = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: bytes, prompt: VISION_PROMPT, max_tokens: 400 });
    return { results: parseVision(r && (r.description || r.response || r.text || '')), engine: 'ai-vision' };
  } catch (e) { console.log('vision error', String(e && e.message || e).slice(0, 200)); return { results: null, reason: 'ai-error' }; }
};

/* ---- users & invitations */
FN.getUserDirectory = async (ctx, p, user) => {
  requireRole(user, ['admin']);
  const users = (await rowsOf(ctx.env, 'SELECT * FROM users WHERE verified=1 ORDER BY created_date ASC')).map((r) => publicUser(userFromRow(r)));
  const inv = (await rowsOf(ctx.env, "SELECT * FROM invitations WHERE status='pending' ORDER BY created_date ASC")).map((i) => ({
    id: 'inv_' + i.id, email: i.email, full_name: '', role: i.role, is_active: true, email_verified: false, verified: false,
    created_date: i.created_date, invitation_status: 'pending', invitation_role: i.role, joined_via_invitation: false
  }));
  return { users: users.concat(inv) };
};
FN.sendInvitation = async (ctx, p, user) => {
  requireRole(user, ['admin']);
  const env = ctx.env, email = normEmail(p.email);
  if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (ROLES.indexOf(p.role) < 0) throw new HttpError(400, 'Invalid role.');
  const ex = await userByEmail(env, email);
  if (ex && ex.verified) throw new HttpError(400, 'A user with this email already exists. Change their role from the Users list instead.');
  let code; do { code = inviteCode(); } while (await Q(env, 'SELECT 1 FROM invitations WHERE code=?', code).first());
  const inv = { id: uuid(), code, email, role: p.role };
  const link = appUrl(ctx) + '/register?invite=' + code, role = ROLE_NAME[p.role];
  await sendMail(env, email, 'You are invited to 3DEXPERIENCE Lab Asset Management as ' + role,
    'Hello,\n\n' + (user.full_name || user.email) + ' invited you to the 3DEXPERIENCE Lab Asset Management app as: ' + role + '.\n\n' +
    'Your invitation code: ' + fmtCode(code) + '\n\nHow to join:\n1. Open ' + link + '\n2. Tap "Create account" and register with THIS email address (' + email + ').\n3. Enter the 6-digit verification code we email you.\nYour role (' + role + ') is applied automatically.\n\nApp address: ' + appUrl(ctx) + installBlock(ctx).text,
    shell('You are invited', '<p><b>' + esc(user.full_name || user.email) + '</b> invited you to the asset management app as <b>' + esc(role) + '</b>.</p>' +
      '<p style="margin:16px 0 4px;color:#64748b;font-size:13px">Your invitation code</p>' +
      '<p style="font-size:28px;letter-spacing:5px;font-weight:bold;background:#f1f5f9;border-radius:8px;text-align:center;padding:14px 0;margin:0 0 18px">' + fmtCode(code) + '</p>' +
      '<p><a href="' + esc(link) + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Accept invitation</a></p>' +
      '<ol style="padding-left:18px;color:#334155"><li>Open the link above (or the app) and tap <b>Create account</b>.</li><li>Register with <b>' + esc(email) + '</b>.</li><li>Enter the 6-digit code we email you.</li></ol>' +
      installBlock(ctx).html + '<p style="color:#64748b;font-size:13px;margin-top:16px">Your role is applied automatically. App address: ' + esc(appUrl(ctx)) + '</p>'));
  await env.DB.batch([
    Q(env, "UPDATE invitations SET status='replaced' WHERE email=? AND status='pending'", email),
    Q(env, "INSERT INTO invitations (id,email,code,role,status,invited_by,created_date) VALUES (?,?,?,?,'pending',?,?)", inv.id, email, code, p.role, user.email, nowIso())
  ]);
  ctx.mutated = true;
  return { email_sent: true, email, role: p.role, invitation_id: inv.id };
};
async function applyInvitation(ctx, user, codeRaw) {
  const env = ctx.env, code = normCode(codeRaw);
  let inv = code ? await Q(env, "SELECT * FROM invitations WHERE code=? AND status='pending'", code).first() : null;
  if (code && !inv) {
    const used = await Q(env, 'SELECT * FROM invitations WHERE code=?', code).first();
    if (used && used.email === user.email && used.status === 'accepted') return { role: user.role };
    throw new HttpError(400, 'This invitation code is invalid or has already been used.');
  }
  if (!inv) inv = await pendingInviteFor(env, user.email);
  if (!inv) return { role: user.role };
  if (inv.email !== user.email) throw new HttpError(403, 'This invitation was sent to a different email address.');
  if (user.role === 'admin') return { role: user.role };
  user.role = inv.role; user.joined_via_invitation = true; user.invitation_status = 'accepted'; user.invitation_role = inv.role; user.invitation_accepted_at = nowIso();
  await env.DB.batch([Q(env, "UPDATE invitations SET status='accepted', accepted_at=? WHERE id=?", nowIso(), inv.id)]);
  await saveUser(env, user); ctx.mutated = true;
  return { role: user.role };
}
FN.applyPendingInvitation = (ctx, p, user) => applyInvitation(ctx, user, null);
FN.acceptInvitation = (ctx, p, user) => applyInvitation(ctx, user, p && p.token);
FN.setUserAppRole = async (ctx, p, user) => {
  requireRole(user, ['admin']);
  const env = ctx.env;
  if (ROLES.indexOf(p.role) < 0) throw new HttpError(400, 'Invalid role.');
  if (String(p.user_id).indexOf('inv_') === 0) {
    await Q(env, "UPDATE invitations SET role=? WHERE id=? AND status='pending'", p.role, String(p.user_id).slice(4)).run();
    ctx.mutated = true; return { success: true };
  }
  const u = userFromRow(await Q(env, 'SELECT * FROM users WHERE id=?', p.user_id).first());
  if (!u) throw new HttpError(404, 'User not found');
  if (u.role === 'admin' && p.role !== 'admin' && (await activeAdminCount(env)) <= 1) throw new HttpError(400, 'At least one active admin is required.');
  u.role = p.role; await saveUser(env, u); ctx.mutated = true;
  return { success: true, user: publicUser(u) };
};
FN.setUserActiveStatus = async (ctx, p, user) => {
  requireRole(user, ['admin']);
  const env = ctx.env;
  if (String(p.user_id).indexOf('inv_') === 0) {
    if (p.is_active === false) await Q(env, "UPDATE invitations SET status='revoked' WHERE id=?", String(p.user_id).slice(4)).run();
    ctx.mutated = true; return { success: true };
  }
  const u = userFromRow(await Q(env, 'SELECT * FROM users WHERE id=?', p.user_id).first());
  if (!u) throw new HttpError(404, 'User not found');
  if (p.is_active === false && u.role === 'admin' && (await activeAdminCount(env)) <= 1) throw new HttpError(400, 'At least one active admin is required.');
  u.is_active = p.is_active !== false; await saveUser(env, u);
  if (!u.is_active) await Q(env, 'DELETE FROM sessions WHERE user_id=?', u.id).run();
  ctx.mutated = true; return { success: true, user: publicUser(u) };
};
FN.deleteUser = async (ctx, p, user) => {
  requireRole(user, ['admin']);
  const env = ctx.env;
  if (String(p.user_id).indexOf('inv_') === 0) { await Q(env, "UPDATE invitations SET status='revoked' WHERE id=?", String(p.user_id).slice(4)).run(); ctx.mutated = true; return { success: true }; }
  const u = userFromRow(await Q(env, 'SELECT * FROM users WHERE id=?', p.user_id).first());
  if (!u) throw new HttpError(404, 'User not found');
  if (u.role === 'admin' && (await activeAdminCount(env)) <= 1) throw new HttpError(400, 'At least one active admin is required.');
  await env.DB.batch([Q(env, 'DELETE FROM sessions WHERE user_id=?', u.id), Q(env, 'DELETE FROM users WHERE id=?', u.id)]);
  ctx.mutated = true; return { success: true };
};

/* ---------------------------------------------------------------- router */
async function route(ctx) {
  const { request, url, env } = ctx, method = request.method;
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  if (parts[0] === 'health') return { body: { ok: true, name: 'lab-asset-management', email_configured: !!env.BREVO_API_KEY, ai: !!(env.GEMINI_API_KEY || env.AI) } };
  if (parts[0] === 'version') { const r = await Q(env, "SELECT value FROM meta WHERE key='version'").first(); return { body: { v: r ? r.value : 0 } }; }
  let body = {};
  if (method !== 'GET' && method !== 'DELETE') {
    const txt = await request.text();
    if (txt) { try { body = JSON.parse(txt); } catch (e) { throw new HttpError(400, 'Invalid request body.'); } }
  }
  if (parts[0] === 'auth') {
    const act = parts[1];
    if (!AUTH[act] || (act === 'me' ? method !== 'GET' : method !== 'POST')) throw new HttpError(404, 'Not found');
    return { body: await AUTH[act](ctx, body) };
  }
  if (parts[0] === 'functions') {
    const name = decodeURIComponent(parts[1] || '');
    if (!FN[name] || method !== 'POST') throw new HttpError(404, 'Unknown function: ' + name);
    let user = null;
    if (name === 'getPublicAsset') { try { user = await authUser(ctx); } catch (e) { user = null; } }
    else user = await authUser(ctx);
    const out = await FN[name](ctx, body, user);
    return out && out.raw !== undefined ? { raw: out.raw } : { body: out };
  }
  if (parts[0] === 'entities') {
    const user = await authUser(ctx), q = {};
    url.searchParams.forEach((v, k) => { q[k] = v; });
    const out = await entityRoute(ctx, method, parts.slice(1), method === 'GET' ? { sort: q.sort, limit: q.limit } : body, user);
    return out && out.raw !== undefined ? { raw: out.raw } : { body: out };
  }
  throw new HttpError(404, 'Not found');
}

const PAGE_CSS = 'body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a}header{background:#0f172a;color:#fff;padding:16px 20px}header b{font-size:18px}header span{display:block;font-size:12px;opacity:.75}' +
  'main{max-width:560px;margin:0 auto;padding:18px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:14px}h1{font-size:22px;margin:0 0 8px}' +
  '.pill{display:inline-block;background:#dbeafe;color:#1d4ed8;border-radius:99px;padding:3px 10px;font-size:13px;margin:0 6px 6px 0}table{width:100%;border-collapse:collapse}td{padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:15px;vertical-align:top}td:first-child{color:#64748b;width:42%}' +
  '.btn{display:block;text-align:center;background:#2563eb;color:#fff;text-decoration:none;padding:13px;border-radius:10px;font-weight:bold;margin-top:12px}';
const page = (title, body) => new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + PAGE_CSS + '</style></head><body><header><b>3DEXPERIENCE Lab</b><span>Asset Management</span></header><main>' + body + '</main></body></html>',
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
async function assetPage(env, tag) {
  const a = await Q(env, 'SELECT data FROM assets WHERE tag_lc=? AND is_deleted=0', String(tag || '').trim().toLowerCase()).first();
  if (!a) return page('Asset not found', '<div class="card"><h1>Asset not found</h1><p>No asset has the tag <b>' + esc(tag) + '</b>.</p></div>');
  const d = JSON.parse(a.data), SL = { in_use: 'In Use', available: 'Available', in_repair: 'In Repair', relocated: 'Relocated', broken: 'Broken', retired: 'Retired' };
  const rows = [['Asset Tag', d.asset_tag], ['Category', d.category], ['Type', d.type], ['Brand', d.brand], ['Model', d.model], ['Location', d.location]]
    .filter((r) => r[1]).map((r) => '<tr><td>' + r[0] + '</td><td><b>' + esc(r[1]) + '</b></td></tr>').join('');
  const body = '<div class="card"><p style="margin:0 0 4px;color:#16a34a;font-size:13px">&#10003; Asset found</p><h1>' + esc(d.name || d.asset_tag) + '</h1>' +
    '<span class="pill">' + esc(SL[d.status] || d.status || '') + '</span><span class="pill" style="background:#dcfce7;color:#15803d">' + esc(d.condition || 'good') + '</span></div>' +
    '<div class="card"><table>' + rows + '</table><a class="btn" href="/scan/' + encodeURIComponent(d.asset_tag) + '">Open full details in the app</a></div>';
  const redirect = '<script>try{if(localStorage.getItem("local_asset_management_access_token"))location.replace("/scan/' + encodeURIComponent(d.asset_tag) + '")}catch(e){}</script>';
  return page(d.name || d.asset_tag, body + redirect);
}
function installPage(env, origin) {
  const apk = env.ANDROID_APK_URL, base = (env.APP_URL || origin).replace(/\/$/, '');
  const body = '<div class="card"><h1>Install the app</h1><p style="color:#475569">App address:<br><b>' + esc(base) + '</b></p></div>' +
    '<div class="card"><h2 style="margin:0 0 8px;font-size:18px">iPhone / iPad</h2><ol style="padding-left:20px;line-height:1.6"><li>Open <b>' + esc(base) + '</b> in <b>Safari</b>.</li><li>Tap the Share button.</li><li>Tap <b>Add to Home Screen</b>.</li></ol></div>' +
    '<div class="card"><h2 style="margin:0 0 8px;font-size:18px">Android</h2>' + (apk ? '<a class="btn" style="margin:0 0 10px" href="' + esc(apk) + '">Download the Android app</a><p style="color:#475569;font-size:14px">Open the downloaded file and allow "Install unknown apps". On first launch paste <b>' + esc(base) + '</b>.</p>' : '') +
    '<p style="color:#475569;font-size:14px;margin-bottom:0">Or in Chrome: open <b>' + esc(base) + '</b>, tap the menu and choose <b>Install app</b> / <b>Add to Home screen</b>.</p></div>' +
    '<a class="btn" href="/register">Create your account</a>';
  return page('Install the app', body);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET' && /^\/a\/[^/]+\/?$/.test(url.pathname)) { try { return await assetPage(env, decodeURIComponent(url.pathname.split('/')[2])); } catch (e) { return page('Error', '<div class="card"><h1>Something went wrong</h1><p>Please try again.</p></div>'); } }
    if (request.method === 'GET' && /^\/install\/?$/.test(url.pathname)) return installPage(env, url.origin);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    const ctx = { env, url, request, mutated: false };
    const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS);
    try {
      const out = await route(ctx);
      if (ctx.mutated) {
        const r = await Q(env, "UPDATE meta SET value=value+1 WHERE key='version' RETURNING value").first();
        if (r) headers['x-data-version'] = String(r.value);
      }
      return new Response(out.raw !== undefined ? out.raw : JSON.stringify(out.body), { status: 200, headers });
    } catch (e) {
      if (e instanceof HttpError) return new Response(JSON.stringify({ error: e.message, detail: e.message }), { status: e.status, headers });
      const msg = String(e && e.message || e);
      console.log('server error', msg);
      if (/UNIQUE constraint failed: assets\.tag_lc|duplicate key value.*tag_lc/.test(msg)) return new Response(JSON.stringify({ error: 'That asset tag is already in use.', detail: 'That asset tag is already in use.' }), { status: 409, headers });
      return new Response(JSON.stringify({ error: 'Server error. Please try again.', detail: msg.slice(0, 200) }), { status: 500, headers });
    }
  }
};
