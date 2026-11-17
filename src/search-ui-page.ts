import { secretMatches } from './secret'

// The search UI's page + auth, kept pure so they're testable without a DB or a socket.

// Group names come from WhatsApp, i.e. from anyone who adds Gizmo to a group: escape everything.
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const COOKIE = 'gizmo_ui'

// The owner opens /?key=<secret> once; the server swaps it for a cookie. API calls carry the cookie.
export function presentedKey(url: URL, cookieHeader: string | undefined): string | undefined {
  const fromCookie = (cookieHeader ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1]
  return url.searchParams.get('key') ?? (fromCookie ? decodeURIComponent(fromCookie) : undefined)
}

// Scope picker: "everything" = search as the owner (Dan), unscoped. Any other option
// is a group Gizmo is in — picking it simulates someone asking Gizmo IN that group, so
// results are limited to that group's messages (exactly the runtime ACL).
export function renderPage(o: { ownerLabel: string; groups: Array<{ jid: string; name?: string }> }): string {
  const scopeOptions = [
    `<option value="">everything (as ${escapeHtml(o.ownerLabel)})</option>`,
    ...o.groups.map((g) => `<option value="${escapeHtml(g.jid)}">in: ${escapeHtml(g.name ?? g.jid)}</option>`),
  ].join('')
  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gizmo Search</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0b141a;color:#e9edef}
header{position:sticky;top:0;background:#111b21;padding:14px 16px;border-bottom:1px solid #222d34;z-index:2}
h1{margin:0 0 10px;font-size:16px;color:#8696a0;font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap}
input,select{background:#2a3942;border:1px solid #2a3942;color:#e9edef;border-radius:8px;padding:9px 12px;font-size:14px}
#q{flex:1;min-width:220px}
.filters input{width:130px}
button{background:#00a884;color:#0b141a;border:0;border-radius:8px;padding:9px 16px;font-weight:600;cursor:pointer}
button:hover{background:#06cf9c}
#meta{color:#8696a0;font-size:13px;padding:10px 16px}
.card{padding:10px 16px;border-bottom:1px solid #1b262c}
.card .top{display:flex;gap:8px;font-size:12px;color:#8696a0;margin-bottom:3px;flex-wrap:wrap}
.chat{color:#53bdeb}.sender{color:#00a884;font-weight:600}
.text{white-space:pre-wrap;word-break:break-word}
.text[dir=rtl]{text-align:right}
.empty{padding:40px 16px;text-align:center;color:#8696a0}
details{margin-top:8px}summary{cursor:pointer;color:#8696a0;font-size:13px}
</style></head><body>
<header>
  <h1>🤖 Gizmo — search history</h1>
  <div class="row">
    <input id="q" placeholder="Search anything… (Hebrew or English)" autofocus>
    <button onclick="go()">Search</button>
  </div>
  <details><summary>filters</summary>
    <div class="row filters" style="margin-top:8px">
      <input id="from" placeholder="from (sender)">
      <input id="after" placeholder="after YYYY-MM-DD">
      <input id="before" placeholder="before YYYY-MM-DD">
      <select id="scope" title="search scope (ACL)">${scopeOptions}</select>
      <select id="sort"><option value="recent">newest first</option><option value="relevance">relevance</option></select>
      <select id="limit"><option>15</option><option>30</option><option>50</option></select>
      <label style="display:flex;align-items:center;gap:5px;color:#8696a0;font-size:13px"><input type="checkbox" id="hidebot"> hide Gizmo</label>
    </div>
  </details>
</header>
<div id="meta"></div>
<div id="results"></div>
<script>
const $=id=>document.getElementById(id)
const rtl=s=>/[\\u0590-\\u05FF\\u0600-\\u06FF]/.test(s||'')
async function go(){
  const q=$('q').value.trim(); if(!q)return
  $('meta').textContent='searching…'; $('results').innerHTML=''
  const p=new URLSearchParams({q,limit:$('limit').value,sort:$('sort').value})
  for(const k of ['from','after','before','scope']){const v=$(k).value.trim(); if(v)p.set(k,v)}
  if($('hidebot').checked)p.set('hidebot','1')
  const r=await fetch('/api/search?'+p); const d=await r.json()
  const sSel=$('scope'); const sLabel=sSel.options[sSel.selectedIndex].text
  $('meta').textContent=d.results.length+' results · '+sLabel
  $('results').innerHTML=d.results.length?d.results.map(m=>{
    const dir=rtl(m.text)?'rtl':'ltr'
    return '<div class="card"><div class="top"><span>'+m.date+'</span>'+
      (m.chatName?'<span class="chat">· '+(m.isGroup?'':'↔ ')+esc(m.chatName)+'</span>':(m.isGroup?'<span class="chat">· group</span>':'<span class="chat">· 1:1</span>'))+
      '<span class="sender">'+esc(m.senderName||'Unknown')+'</span></div>'+
      '<div class="text" dir="'+dir+'">'+esc(m.text)+'</div></div>'
  }).join(''):'<div class="empty">no matching messages</div>'
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
$('q').addEventListener('keydown',e=>{if(e.key==='Enter')go()})
</script></body></html>`
}
