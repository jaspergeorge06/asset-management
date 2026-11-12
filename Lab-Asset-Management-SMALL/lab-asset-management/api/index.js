import worker from './_worker.js';
import { getDb } from './_pg.js';

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return req.body;
    return JSON.stringify(req.body);
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.searchParams.get('__p');
    if (p) { url.searchParams.delete('__p'); url.pathname = p; }
    const host = req.headers['x-forwarded-host'] || req.headers.host, proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(proto + '://' + host + url.pathname + url.search, { method: req.method, headers: req.headers, body: hasBody ? await readBody(req) : undefined });
    const env = Object.assign({}, process.env, { ASSETS: null });
    const isApi = url.pathname.startsWith('/api/');
    if (isApi || url.pathname.startsWith('/a/')) env.DB = await getDb();
    const r = await worker.fetch(request, env);
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    const msg = String((e && e.message) || e);
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: /No database/.test(msg) ? msg : 'Server error. Please try again.', detail: msg.slice(0, 300) }));
  }
}
