// Turns the text a vision model writes into [{name, quantity, confidence}]
export const VISION_PROMPT = 'List every distinct physical object you can clearly see in this image, with how many of each. ' +
  'Reply ONLY with one line per object in exactly this format: <count> x <object name>. ' +
  'Examples: "4 x chair", "1 x laptop". Do not describe the scene. Do not list anything that is not visible.';
export function parseVision(text) {
  const out = {}, lines = String(text || '').split(/\n|;|,(?=\s*\d+\s*[x×])/);
  for (let line of lines) {
    line = line.replace(/^\s*(?:\d{1,2}[.)]\s+|[-*•]\s+)/, '').trim();
    let m = line.match(/^(?:[-*•]\s*)?(\d{1,3})\s*[x×]\s*(.+)$/i) || line.match(/^(?:[-*•]\s*)?(.+?)\s*[:\-–]\s*(\d{1,3})$/);
    if (!m) continue;
    let qty, name;
    if (/^\d/.test(m[1]) && m[2] && !/^\d+$/.test(m[2])) { qty = parseInt(m[1], 10); name = m[2]; } else { name = m[1]; qty = parseInt(m[2], 10); }
    name = String(name).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9 \-\/&]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || !qty || qty < 1 || qty > 500 || name.length > 60 || /^(none|nothing|object|objects|image|picture|photo)$/.test(name)) continue;
    if (qty > 1) name = name.replace(/ies$/, 'y').replace(/(ch|sh|ss|x)es$/, '$1').replace(/([^s])s$/, '$1');
    out[name] = (out[name] || 0) + qty;
  }
  return Object.keys(out).map((n) => ({ name: n, quantity: out[n], confidence: 0.8 })).sort((a, b) => b.quantity - a.quantity);
}

export const GEMINI_PROMPT = 'Look at this image and list every distinct physical object that is clearly visible, with the number of each. ' +
  'Return ONLY a JSON array like [{"name":"chair","quantity":4},{"name":"laptop","quantity":1}]. ' +
  'Use short, simple, singular, lowercase names. Do not list anything you cannot clearly see. If nothing is recognisable return [].';
export function parseGemini(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(), arr;
  try { arr = JSON.parse(t); } catch (e) { const m = t.match(/\[[\s\S]*\]/); try { arr = m ? JSON.parse(m[0]) : []; } catch (e2) { arr = []; } }
  if (arr && !Array.isArray(arr)) arr = arr.objects || arr.items || [];
  const out = {};
  (arr || []).forEach((o) => {
    let name = String((o && (o.name || o.object || o.item)) || '').toLowerCase().replace(/[^a-z0-9 \-\/&]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = Math.round(Number(o && (o.quantity || o.count || o.qty || 1)));
    if (!name || !(q >= 1) || q > 500 || name.length > 60) return;
    out[name] = (out[name] || 0) + q;
  });
  return Object.keys(out).map((n) => ({ name: n, quantity: out[n], confidence: 0.9 })).sort((a, b) => b.quantity - a.quantity);
}
