const CACHE='lab-assets-65007531';
const FILES=["/app-runtime.js", "/apple-touch-icon.png", "/assets/html2canvas.esm-QH1iLAAe.js", "/assets/index-U1NibjAZ.js", "/assets/index-ZMLDd25k.js", "/assets/index-xcEsxD_-.css", "/assets/index.es-BcHkwZpH.js", "/assets/purify.es-Jn2rvFN8.js", "/assets/xlsx-CkFp8p6R.js", "/icon-192.png", "/icon-512.png", "/index.html", "/manifest.json", "/"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url); if(u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname==='/config.js') return;
  e.respondWith(caches.match(r,{ignoreSearch:true}).then(hit=>hit||fetch(r).catch(()=>r.mode==='navigate'?caches.match('/index.html'):Response.error())));
});
