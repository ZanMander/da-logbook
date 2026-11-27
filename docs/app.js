'use strict';
/* DA Logbook v0.2 — SARS travel logbook + proof-of-work record. Single-user PWA on Supabase (Auth + RLS). */

// ====================================================================
// CONFIG
// ====================================================================
const CONFIG = {
  url: 'https://nnwiuooawsyfspkqerhv.supabase.co',
  key: 'sb_publishable_sQbai9pzpZsgBwCwE3CYww_EIglJnnD',     // publishable key: safe in the browser, RLS does the protecting
  osrm: 'https://router.project-osrm.org',
  nominatim: 'https://nominatim.openstreetmap.org',
  estimateFactor: 1.25,            // straight line -> road estimate when routing is unavailable
  version: '0.3.0'
};
const SITE_URL = location.origin + location.pathname;
const PLACE_TYPES = [['home','Home'],['nwu','NWU'],['municipal_offices','Municipal offices'],['ward','Ward / constituency'],['other','Other']];
const EXPENSE_CATS = [
  ['secretarial_stationery_telephone','Secretarial, stationery, postage, telephone'],
  ['office_accommodation','Office accommodation'],
  ['travel','Travel (actual cost)'],
  ['hospitality','Hospitality at official functions'],
  ['subsistence','Subsistence & incidentals']];

// ====================================================================
// UTILITIES
// ====================================================================
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); }));
const pad = n => String(n).padStart(2,'0');
const localDate = (d=new Date()) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const dayStartIso = d => new Date(d+'T00:00:00').toISOString();          // local midnight as a UTC instant
const dayEndIso = d => new Date(d+'T23:59:59.999').toISOString();
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'}) : '';
const fmtDate = iso => iso ? new Date(iso+(iso.length===10?'T00:00:00':'')).toLocaleDateString('en-ZA',{weekday:'short',day:'numeric',month:'short'}) : '';
const fmtDateLong = iso => iso ? new Date(iso+(iso.length===10?'T00:00:00':'')).toLocaleDateString('en-ZA',{day:'numeric',month:'long',year:'numeric'}) : '';
const fmtDur = ms => { const s=Math.max(0,Math.floor(ms/1000)); const hh=Math.floor(s/3600), mm=Math.floor(s%3600/60), ss=s%60; return `${pad(hh)}:${pad(mm)}:${pad(ss)}`; };
const fmtH = ms => { const m=Math.max(0,Math.round(ms/60000)); return m>=60 ? `${Math.floor(m/60)}h${pad(m%60)}` : `${m}m`; };
const fmtR = n => n==null ? '—' : 'R' + Number(n).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtKm = n => n==null ? '—' : Number(n).toLocaleString('en-ZA',{minimumFractionDigits:1,maximumFractionDigits:1});
const fmtCoord = f => f ? `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : '';
const numOrNull = v => (v===''||v==null) ? null : Number(v);
const ls = {
  get(k, d){ try { const v = localStorage.getItem(k); return v==null ? d : JSON.parse(v); } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
  del(k){ try { localStorage.removeItem(k); } catch(e){} }
};
function haversineKm(a,b){ const R=6371, toR=x=>x*Math.PI/180; const dLat=toR(b.lat-a.lat), dLng=toR(b.lng-a.lng); const s=Math.sin(dLat/2)**2+Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(s)); }
function taxYearLabelFor(dateStr){ const d=new Date(dateStr+'T00:00:00'); const y=d.getMonth()>=2 ? d.getFullYear() : d.getFullYear()-1; return `${y}/${String(y+1).slice(2)}`; }
let toastT; function toast(msg, ms=2800){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'), ms); }
function busy(msg, action){
  let b=$('#busy'); if(!msg){ if(b) b.remove(); return; }
  if(!b){ b=document.createElement('div'); b.className='busy'; b.id='busy'; b.innerHTML='<div><p></p><button type="button" class="btn small" hidden></button></div>'; document.body.appendChild(b); }
  $('p',b).textContent=msg; const btn=$('button',b);
  if(action){ btn.hidden=false; btn.textContent=action.label; btn.onclick=action.onClick; } else { btn.hidden=true; btn.onclick=null; }
}
// Wraps handlers so a rejected write shows its message instead of failing silently.
const guard = fn => async (...a) => { try { await fn(...a); } catch(e){ console.error(e); busy(null); toast(e && e.message ? e.message : String(e), 5000); } };
const FORMS = {};   // form id -> submit handler; each section registers its own

// ====================================================================
// SUPABASE + STATE
// ====================================================================
// What the address carried when the app opened. After an email link, Supabase forwards here with either sign-in tokens
// or an error in the address. An error is read and removed now; tokens are left for the client library to use.
const LANDING = (() => {
  const raw = (location.hash || '').replace(/^#/, ''); const q = new URLSearchParams(location.search);
  const p = /(^|&)(access_token|error|error_code|error_description)=/.test(raw) ? new URLSearchParams(raw) : new URLSearchParams();
  const err = p.get('error_description') || q.get('error_description') || p.get('error') || q.get('error');
  if (err) { try { history.replaceState(null, '', location.pathname); } catch (e) {} return { error: err, code: p.get('error_code') || q.get('error_code') || '' }; }
  if (p.get('access_token')) return { pending: true, type: p.get('type') || '' };
  return null;
})();
const sb = supabase.createClient(CONFIG.url, CONFIG.key, { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
const S = {
  user:null, ready:false, vehicles:[], vehicle:null, taxYears:[], params:[], categories:[], places:[],
  activeTrip: ls.get('dalog.activeTrip', null), activeTask: ls.get('dalog.activeTask', null),
  log: ls.get('dalog.logcache', {trips:[],tasks:[],expenses:[],evidence:[]}),
  view:'home', edit:null, editExpense:null, taskDetail:null, summary:null, summaryTaxYearId:null
};
const saveLog = () => ls.set('dalog.logcache', S.log);

// ---- offline outbox: every write goes through here, strictly in order ------------------
const OUTBOX='dalog.outbox', FAILED='dalog.failed';
function isNetErr(e){ const m=String((e && e.message) || e || '').toLowerCase(); return !navigator.onLine || (e instanceof TypeError) || /failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|aborted/.test(m); }
// Permanent = the server understood the request and refused it (constraint, RLS, missing row). Anything else is retried.
function isPermanent(e){ if(!e || isNetErr(e)) return false; const c=String(e.code||''); if(/^PGRST30[0-9]$/.test(c)) return false;   // expired/invalid token: retry after refresh
  return /^([0-9]{2}[0-9A-Z]{3}|P[0-9]{4}|PGRST[0-9]+)$/.test(c) || /not found on the server/i.test(String(e.message||'')); }
async function runOp(op){
  if(op.type==='insert'){ const {error}=await sb.from(op.table).insert(op.data); if(error && error.code!=='23505') throw error; }
  else if(op.type==='upsert'){ const {error}=await sb.from(op.table).upsert(op.data); if(error) throw error; }
  else if(op.type==='update'){ const {data,error}=await sb.from(op.table).update(op.data).eq('id',op.id).select('id'); if(error) throw error; if(!data || !data.length){ const e=new Error('Record not found on the server ('+op.table+')'); throw e; } }
  else if(op.type==='delete'){ const {error}=await sb.from(op.table).delete().eq('id',op.id); if(error) throw error; }
}
function enqueue(op){ const stored={...op, key:uuid(), at:new Date().toISOString(), tries:0}; const q=ls.get(OUTBOX,[]); q.push(stored); ls.set(OUTBOX,q); renderSync(); return stored.key; }
let flushP=null;
function flush(){ if(flushP) return flushP; flushP=doFlush().finally(()=>{ flushP=null; renderSync(); }); return flushP; }
async function doFlush(){
  if(!navigator.onLine || !S.user) return;
  let sent=0;
  for(;;){
    const q=ls.get(OUTBOX,[]); if(!q.length) break; const op=q[0]; let outcome='sent', err=null;
    try { await runOp(op); sent++; } catch(e){ err=e; outcome = (!isPermanent(e) && (op.tries||0) < 8) ? 'retry' : 'failed'; }
    const cur=ls.get(OUTBOX,[]);                                    // re-read: more may have been queued while we waited
    if(outcome==='retry'){ const i=cur.findIndex(x=>x.key===op.key); if(i>=0){ cur[i].tries=(cur[i].tries||0)+1; ls.set(OUTBOX,cur); } break; }   // keep order: stop here
    if(outcome==='failed'){ const failed=ls.get(FAILED,[]); failed.push({op, error:String((err && err.message) || err), at:new Date().toISOString()}); ls.set(FAILED,failed); }
    ls.set(OUTBOX, cur.filter(x=>x.key!==op.key));
  }
  if(sent>1) toast('Synced '+sent+' queued changes');
}
// Returns {ok} when saved on the server, {queued} when held on the phone. Throws when the server refuses it.
async function write(op){
  if(ls.get(OUTBOX,[]).length || !navigator.onLine || !S.user){
    const key=enqueue(op); await flush();
    const all=ls.get(FAILED,[]); const mine=all.find(f=>f.op.key===key);
    if(mine){ ls.set(FAILED, all.filter(f=>f.op.key!==key)); throw new Error(mine.error); }      // refused: tell the caller now, as the direct path does
    return ls.get(OUTBOX,[]).some(x=>x.key===key) ? {queued:true} : {ok:true};
  }
  try { await runOp(op); return {ok:true}; }
  catch(e){ if(isPermanent(e)) throw e; enqueue(op); return {queued:true}; }
}
function renderSync(){ const el=$('#sync'); if(!el) return; const q=ls.get(OUTBOX,[]).length; const on=navigator.onLine; el.className='sync'+(on?'':' off')+(q?' queued':''); el.lastElementChild.textContent = !on ? 'offline' + (q?` · ${q} queued`:'') : (q ? `${q} queued` : 'online'); }
window.addEventListener('online', ()=>{ renderSync(); flush(); });
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) flush(); });

// ---- geolocation: watch briefly and keep the most accurate fix ---------------------------
let skipFix=null;
const gpsSkip={label:'Continue without GPS', onClick:()=>{ if(skipFix) skipFix(); }};
function getFix({timeout=15000, good=25, settle=5000}={}){
  return new Promise(res=>{
    if(!navigator.geolocation) return res(null);
    let best=null, done=false, wid=null, settleT=null, hardT=null;
    const finish=()=>{ if(done) return; done=true; skipFix=null; try{ navigator.geolocation.clearWatch(wid); }catch(e){} clearTimeout(settleT); clearTimeout(hardT); res(best); };
    hardT=setTimeout(finish, timeout); skipFix=finish;
    try{
      wid=navigator.geolocation.watchPosition(p=>{
        const f={lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy||0)};
        if(!best || f.acc<=best.acc) best=f;
        if(best.acc<=good) return finish();
        if(!settleT) settleT=setTimeout(finish, settle);          // coarse fix: give GPS a few more seconds to sharpen
      }, err=>{ if(err && err.code===1) finish(); }, {enableHighAccuracy:true, maximumAge:0, timeout});
    }catch(e){ finish(); }
  });
}
function nearestPlace(fix){ if(!fix) return null; let best=null; for(const p of S.places){ const d=haversineKm(fix,{lat:p.lat,lng:p.lng})*1000; if(d<=p.radius_m && (!best||d<best.d)) best={p,d}; } return best?best.p:null; }
const timeoutSignal = ms => (typeof AbortSignal!=='undefined' && AbortSignal.timeout) ? AbortSignal.timeout(ms) : undefined;
async function routeKm(a,b){
  if(a&&b){
    const st=Math.round(haversineKm(a,b)*10)/10;
    if(navigator.onLine){
      try{ const r=await fetch(`${CONFIG.osrm}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`,{signal:timeoutSignal(12000)}); const j=await r.json();
        if(j.code==='Ok' && j.routes && j.routes[0]) return {km:Math.round(j.routes[0].distance/100)/10, source:'osrm', straight:st}; }catch(e){}
    }
    return {km:Math.round(st*CONFIG.estimateFactor*10)/10, source:'estimate', straight:st};
  }
  return {km:null, source:'manual', straight:null};
}
async function placeName(fix){
  if(!fix) return '';
  const p=nearestPlace(fix); if(p) return p.name;
  if(!navigator.onLine) return fmtCoord(fix);
  try{ const r=await fetch(`${CONFIG.nominatim}/reverse?format=jsonv2&lat=${fix.lat}&lon=${fix.lng}&zoom=17`,{signal:timeoutSignal(8000),headers:{Accept:'application/json'}}); const j=await r.json(); const a=j.address||{};
    // The map data labels some areas with old municipal ward numbers ("Tlokwe Ward 24"). A wrong ward number in a
    // councillor's logbook is worse than none, so ward-style labels are dropped.
    const notWard = s => s && !/\bward\s*\d+/i.test(s) ? s : null;
    const parts=[a.amenity||a.building||a.shop||a.office, a.road||a.pedestrian, notWard(a.suburb)||notWard(a.neighbourhood)||a.hamlet||a.village, a.city||a.town||a.municipality].filter(Boolean);
    const name=[...new Set(parts)].join(', '); return name || j.display_name || fmtCoord(fix);
  }catch(e){ return fmtCoord(fix); }
}

// ---- data loading ------------------------------------------------------------------------
async function loadRefs(){
  const [v,ty,p,c,pl]=await Promise.all([
    sb.from('vehicles').select('*').order('created_at'),
    sb.from('tax_years').select('*').order('year_label',{ascending:false}),
    sb.from('tax_year_params').select('*').order('starts_on',{ascending:false}),
    sb.from('task_categories').select('*').eq('active',true).order('sort_order'),
    sb.from('places').select('*').order('name')
  ]);
  for(const r of [v,ty,p,c,pl]) if(r.error) throw r.error;
  S.vehicles=v.data; S.vehicle=v.data.find(x=>x.active)||v.data[0]||null; S.taxYears=ty.data; S.params=p.data; S.categories=c.data; S.places=pl.data;
  ls.set('dalog.refs',{vehicles:S.vehicles,taxYears:S.taxYears,params:S.params,categories:S.categories,places:S.places});
}
function loadRefsFromCache(){ const r=ls.get('dalog.refs',null); if(r){ Object.assign(S,r); S.vehicle=S.vehicles.find(x=>x.active)||S.vehicles[0]||null; } }
const queuedFor = (table,id) => ls.get(OUTBOX,[]).some(o=>o.table===table && ((o.data && o.data.id===id) || o.id===id));
async function loadActive(){
  const [t,k]=await Promise.all([sb.from('trips').select('*').eq('status','active').order('started_at',{ascending:false}).limit(1), sb.from('task_sessions').select('*').eq('status','active').order('started_at',{ascending:false}).limit(1)]);
  if(!t.error){ const srv=t.data[0]||null, loc=S.activeTrip;
    S.activeTrip = (loc && queuedFor('trips',loc.id)) ? loc : srv ? {...(loc && loc.id===srv.id ? loc : {}), ...srv} : null; ls.set('dalog.activeTrip',S.activeTrip); }
  if(!k.error){ const srv=k.data[0]||null, loc=S.activeTask;
    S.activeTask = (loc && queuedFor('task_sessions',loc.id)) ? loc : srv ? {...(loc && loc.id===srv.id ? loc : {}), ...srv} : null; ls.set('dalog.activeTask',S.activeTask); }
  if(S.activeTask && !queuedFor('task_sessions',S.activeTask.id)){ const e=await sb.from('evidence').select('*').eq('task_session_id',S.activeTask.id).order('captured_at'); if(!e.error){ const local=(S.activeTask._evidence||[]).filter(x=>queuedFor('evidence',x.id)); S.activeTask._evidence=[...e.data, ...local.filter(x=>!e.data.some(y=>y.id===x.id))]; ls.set('dalog.activeTask',S.activeTask); } }
}
async function loadLog(days=90){
  const since=localDate(new Date(Date.now()-days*86400000)); const sinceTs=dayStartIso(since);
  const [t,k,x,e]=await Promise.all([
    sb.from('trips').select('*').gte('trip_date',since).neq('status','discarded').order('started_at',{ascending:false}),
    sb.from('task_sessions').select('*').gte('started_at',sinceTs).neq('status','discarded').order('started_at',{ascending:false}),
    sb.from('expenses').select('*').gte('expense_date',since).order('expense_date',{ascending:false}),
    sb.from('evidence').select('id,kind,captured_at,lat,trip_id,task_session_id,expense_id,note,reference,storage_path,odometer_km').gte('captured_at',sinceTs).order('captured_at')
  ]);
  for(const r of [t,k,x,e]) if(r.error) throw r.error;
  S.log={trips:t.data,tasks:k.data,expenses:x.data,evidence:e.data}; saveLog();
}

// ====================================================================
// ROUTER + SHELL
// ====================================================================
const VIEWS={home:'DA Logbook',log:'Log',expenses:'Expenses',export:'Export',settings:'Settings',trip:'Trip',task:'Task','task-start':'Start a task','task-manual':'Log a past task','task-detail':'Task',expense:'Expense',evidence:'Evidence'};
const TOP=['home','log','expenses','export','settings'];
function go(v){ if(location.hash!=='#'+v) location.hash='#'+v; else render(); }
window.addEventListener('hashchange', ()=>render());
$('#backBtn').addEventListener('click', ()=>{ if(history.length>1) history.back(); else go('home'); });
function render(){
  const v=(location.hash||'#home').slice(1); S.view = VIEWS[v]?v:'home';
  const account = !S.user || AUTH.mode==='newPassword';          // the account screens replace the app until signed in
  $('#title').textContent = account ? 'DA Logbook' : VIEWS[S.view]; $('#backBtn').hidden = TOP.includes(S.view) || account;
  $('#nav').hidden=account;
  $$('#nav a').forEach(a=>a.classList.toggle('active', a.dataset.v===S.view));
  window.scrollTo(0,0);
  if(account){ $('#main').innerHTML=renderAuth(); return; }
  ({home:renderHome, log:renderLog, expenses:renderExpenses, export:renderExport, settings:renderSettings, trip:renderTripForm, 'task-start':renderTaskStart, 'task-manual':renderTaskManual, task:renderTaskActive, 'task-detail':renderTaskDetail, expense:renderExpenseForm, evidence:renderEvidenceForm})[S.view]();
  renderSync(); tick();
}
function tick(){ $$('[data-since]').forEach(el=>{ const end = el.dataset.until ? new Date(el.dataset.until).getTime() : Date.now(); el.textContent=fmtDur(end-new Date(el.dataset.since).getTime()); }); }
setInterval(tick, 1000);

// ====================================================================
// AUTH
// ====================================================================
// Screens: signin · create · confirm (waiting for the email link) · forgot · forgotSent · newPassword (after a reset link).
// The password typed at sign-up is held in memory only (AUTH.pending) so the app can finish signing in by itself once the
// email is confirmed; it is never stored.
const AUTH = { mode:'signin', email: ls.get('dalog.email',''), msg:'', msgKind:'warn', ownerClaimed:null, pending:null, resendAt:0, landed:false, lastTry:0 };
if(LANDING && LANDING.error){ AUTH.landed=true; AUTH.msg = /expired|invalid|denied/i.test(LANDING.error+' '+LANDING.code) ? 'That email link has expired or was already used. Sign in with your password, or ask for a new link.' : LANDING.error.replace(/\+/g,' '); }
function renderAuth(){
  const m=AUTH.mode, e=h(AUTH.email);
  const note=`<div id="authMsg" role="alert" class="${AUTH.msg?'banner '+(AUTH.msgKind==='ok'?'info':'warn'):''}">${h(AUTH.msg)}</div>`;
  const emailField=`<label class="f">Email<input class="input" type="email" id="authEmail" name="email" value="${e}" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>`;
  const pwField=(id,ac,label)=>`<label class="f">${label}<span class="pw"><input class="input" type="password" id="${id}" name="password" autocomplete="${ac}" autocapitalize="none" spellcheck="false"><button type="button" class="btn small" data-auth="togglePw" aria-pressed="false" aria-label="Show password">Show</button></span></label>`;
  const head=`<div><h1>DA Logbook</h1><p class="muted">Travel log and proof of work.</p></div>`;
  if(LANDING && LANDING.pending && !AUTH.landed) return `<div class="auth stack">${head}<div class="card"><h3>Signing you in…</h3><p class="small muted">Finishing the link you tapped.</p></div></div>`;
  if(m==='newPassword') return `<div class="auth stack">${head}${note}
    <form id="newPassForm" class="stack card" novalidate><h3>Choose a new password</h3>${pwField('newPass1','new-password','New password (8 or more characters)')}<button class="btn primary block" type="submit">Save and continue</button></form></div>`;
  if(m==='confirm') return `<div class="auth stack">${head}${note}
    <div class="stack card"><h3>Confirm your email</h3>
      <p style="margin:0">A confirmation link is on its way to <b>${e}</b>. Open that email and tap the link.</p>
      <p class="small muted" style="margin:0">Then come back to this screen: it signs you in by itself. The sender is Supabase Auth; look in spam if nothing arrives within a minute.</p>
      <button class="btn primary block" type="button" data-auth="continue">I have tapped the link</button>
      <button class="btn block" type="button" data-auth="resend">Send the email again</button>
      <button class="btn ghost block small" type="button" data-auth="mode" data-mode="create">Use a different address</button></div></div>`;
  if(m==='forgot') return `<div class="auth stack">${head}${note}
    <form id="forgotForm" class="stack card" novalidate><h3>Reset your password</h3><p class="small muted" style="margin:0">You get an email with a link. Tapping it opens this app on a screen where you choose a new password.</p>${emailField}<button class="btn primary block" type="submit">Email me a reset link</button></form>
    <button class="btn ghost block" type="button" data-auth="mode" data-mode="signin">Back to sign in</button></div>`;
  if(m==='forgotSent') return `<div class="auth stack">${head}${note}
    <div class="stack card"><h3>Check your email</h3><p style="margin:0">If <b>${e}</b> has an account here, a reset link is on its way. Open it on this device.</p><p class="small muted" style="margin:0">Use the newest email if you asked more than once: each new link cancels the one before.</p></div>
    <button class="btn block" type="button" data-auth="mode" data-mode="signin">Back to sign in</button></div>`;
  if(m==='create') return `<div class="auth stack">${head}${note}
    <form id="authForm" data-kind="create" class="stack card" novalidate><h3>Create the owner account</h3>
      <p class="small muted" style="margin:0">One account owns this logbook. Use an address whose mail you can open now: a confirmation link is sent to it.</p>
      ${emailField}${pwField('authPass','new-password','Choose a password (8 or more characters)')}
      <button class="btn primary block" type="submit">Create account</button></form>
    <button class="btn ghost block" type="button" data-auth="mode" data-mode="signin">I already have an account</button></div>`;
  return `<div class="auth stack">${head}${note}
    <form id="authForm" data-kind="signin" class="stack card" novalidate><h3>Sign in</h3>
      ${emailField}${pwField('authPass','current-password','Password')}
      <button class="btn primary block" type="submit">Sign in</button>
      <button class="btn ghost block small" type="button" data-auth="mode" data-mode="forgot">Forgot password?</button></form>
    ${AUTH.ownerClaimed===true ? '<p class="small muted">This logbook already has its owner account, so new sign-ups are closed. You stay signed in on this device until you sign out.</p>'
      : `<button class="btn block" type="button" data-auth="mode" data-mode="create">${AUTH.ownerClaimed===false?'First time here? Create the owner account':'Create account'}</button>`}
  </div>`;
}
function authNote(msg, kind='warn'){ AUTH.msg=msg; AUTH.msgKind=kind; const el=$('#authMsg'); if(el){ el.className = msg ? 'banner '+(kind==='ok'?'info':'warn') : ''; el.textContent=msg; } }
function authErrorText(error){
  const c=String(error.code||''), m=String(error.message||error);
  if(isNetErr(error)) return 'No connection. Check your signal and try again.';
  if(c==='invalid_credentials' || /invalid login credentials/i.test(m)) return 'That email and password do not match.';
  const wait=m.match(/after (\d+) seconds?/i); if(wait) return `Wait ${wait[1]} seconds before asking for another email.`;
  if(c==='over_email_send_rate_limit' || /rate limit/i.test(m)) return 'Too many emails were requested. The mail service allows only a few an hour: wait a while, then try again.';
  if(c==='weak_password' || /password should/i.test(m)) return 'Choose a stronger password of at least 8 characters.';
  if(c==='same_password') return 'That is your current password. Choose a different one.';
  if(c==='user_already_exists' || /already registered/i.test(m)) return 'That address already has an account. Sign in instead.';
  if(/database error|sign-?ups? (are|not)/i.test(m)) return 'This logbook already has its owner account, so new sign-ups are closed. Sign in instead.';
  if(c==='otp_expired' || /link is invalid|has expired/i.test(m)) return 'That email link has expired or was already used. Ask for a new one.';
  if(c==='email_address_invalid' || c==='email_address_not_authorized' || /email address.*(invalid|not authorized)/i.test(m)) return 'The mail service refused that address. Check the spelling, or use another address.';
  return m;
}
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function setAuthMode(mode){ const el=$('#authEmail'); if(el) AUTH.email=el.value.trim(); if(mode!=='confirm') AUTH.pending=null; AUTH.mode=mode; AUTH.msg=''; render(); const f=$('#authEmail'); if(f && !f.value) f.focus(); }
// Returns true when signed in. An unconfirmed address moves to the confirm screen rather than showing an error.
async function authSignIn(email, password, {quiet=false}={}){
  AUTH.lastTry=Date.now();
  const {error}=await sb.auth.signInWithPassword({email,password});
  if(!error){ ls.set('dalog.email',email); AUTH.pending=null; AUTH.mode='signin'; AUTH.msg=''; return true; }
  if(error.code==='email_not_confirmed' || /not confirmed/i.test(error.message||'')){
    AUTH.pending={email,password}; AUTH.email=email;
    if(AUTH.mode!=='confirm'){ AUTH.mode='confirm'; AUTH.msg=''; render(); }
    else if(!quiet) authNote('Not confirmed yet. Tap the link in the email, then come back.');
    return false;
  }
  if(!quiet) authNote(authErrorText(error));
  return false;
}
FORMS.authForm = async form => {
  const email=$('#authEmail').value.trim().toLowerCase(), password=$('#authPass').value; AUTH.email=email;
  if(!emailOk(email)) return authNote('Enter your email address.');
  if(form.dataset.kind==='create'){
    if(password.length<8) return authNote('Choose a password of at least 8 characters.');
    busy('Creating your account…'); let res; try { res=await sb.auth.signUp({email,password,options:{emailRedirectTo:SITE_URL}}); } finally { busy(null); }
    if(res.error) return authNote(authErrorText(res.error));
    ls.set('dalog.email',email);
    if(res.data.session) return;                                   // no confirmation needed: the session event takes it from here
    if(res.data.user && Array.isArray(res.data.user.identities) && res.data.user.identities.length===0){ AUTH.mode='signin'; render(); return authNote('That address already has an account. Sign in instead.'); }
    AUTH.pending={email,password}; AUTH.mode='confirm'; AUTH.msg=''; AUTH.resendAt=Date.now()+60000; render(); return;
  }
  if(!password) return authNote('Enter your password.');
  busy('Signing in…'); try { await authSignIn(email,password); } finally { busy(null); }
};
FORMS.forgotForm = async () => {
  const email=$('#authEmail').value.trim().toLowerCase(); AUTH.email=email; if(!emailOk(email)) return authNote('Enter your email address.');
  busy('Sending…'); let res; try { res=await sb.auth.resetPasswordForEmail(email,{redirectTo:SITE_URL}); } finally { busy(null); }
  if(res.error) return authNote(authErrorText(res.error));
  AUTH.mode='forgotSent'; AUTH.msg=''; render();
};
FORMS.newPassForm = async () => {
  const p=$('#newPass1').value; if(p.length<8) return authNote('Choose a password of at least 8 characters.');
  busy('Saving…'); let res; try { res=await sb.auth.updateUser({password:p}); } finally { busy(null); }
  if(res.error) return authNote(authErrorText(res.error));
  AUTH.mode='signin'; AUTH.msg=''; toast('Password changed. You are signed in.', 4000); if(location.hash!=='#home') location.hash='#home'; else render();
};
const AUTH_ACTIONS = {
  mode: b => setAuthMode(b.dataset.mode),
  togglePw: b => { const inp=b.parentElement.querySelector('input'); const show=inp.type==='password'; inp.type=show?'text':'password'; b.textContent=show?'Hide':'Show'; b.setAttribute('aria-pressed',String(show)); b.setAttribute('aria-label',show?'Hide password':'Show password'); },
  continue: async () => { if(!AUTH.pending) return setAuthMode('signin'); busy('Checking…'); try { await authSignIn(AUTH.pending.email, AUTH.pending.password); } finally { busy(null); } },
  resend: async () => {
    const left=Math.ceil((AUTH.resendAt-Date.now())/1000); if(left>0) return authNote(`Wait ${left} seconds before asking for another email.`);
    busy('Sending…'); let res; try { res=await sb.auth.resend({type:'signup', email:AUTH.email, options:{emailRedirectTo:SITE_URL}}); } finally { busy(null); }
    if(res.error) return authNote(authErrorText(res.error));
    AUTH.resendAt=Date.now()+60000; authNote('Sent again. Use the newest email: the earlier link no longer works.','ok');
  }
};
// Coming back to the app after tapping the link (from the mail app or another tab) finishes the sign-in without a tap.
function resumeConfirm(){ if(document.hidden || S.user || AUTH.mode!=='confirm' || !AUTH.pending || Date.now()-AUTH.lastTry<4000) return; once('auth', ()=>authSignIn(AUTH.pending.email, AUTH.pending.password, {quiet:true})).catch(()=>{}); }
document.addEventListener('visibilitychange', resumeConfirm); window.addEventListener('focus', resumeConfirm);
// Is the owner account taken? One public yes/no, used only to decide whether "Create account" is offered.
async function loadOwnerStatus(){
  if(S.user || !navigator.onLine) return;
  try{ const {data,error}=await sb.from('app_status').select('owner_claimed').maybeSingle(); if(error || !data) return;
    const first = AUTH.ownerClaimed===null; AUTH.ownerClaimed=!!data.owner_claimed;
    if(S.user || !['signin','create'].includes(AUTH.mode)) return;
    if(first && !AUTH.ownerClaimed && AUTH.mode==='signin' && !AUTH.msg && !typing()) AUTH.mode='create';      // nobody has registered yet: lead with Create
    if(AUTH.ownerClaimed && AUTH.mode==='create' && !typing()) AUTH.mode='signin';
    if(!typing()) render();
  }catch(e){}
}
// Never await Supabase calls inside this callback (the client holds its auth lock while it runs): defer the work.
sb.auth.onAuthStateChange((ev, session)=>{ setTimeout(()=>onAuth(ev, session).catch(e=>console.error(e)), 0); });
// The client re-emits SIGNED_IN whenever the tab regains focus and TOKEN_REFRESHED hourly. Re-rendering on those would
// wipe a half-filled form, so the screen is only redrawn when the signed-in identity actually changes.
let bootedFor=null, authSeen=false;
const typing = () => { const a=document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
async function onAuth(ev, session){
  const user = session ? session.user : null;
  if(!user){
    const changed = !!S.user || !authSeen; authSeen=true; S.user=null; bootedFor=null; S.ready=false;
    if(LANDING && LANDING.pending && !AUTH.landed){ AUTH.landed=true; authNote('That link could not sign you in. Sign in with your password instead.'); render(); }
    else if(changed){ if(AUTH.mode==='newPassword') AUTH.mode='signin'; render(); }
    loadOwnerStatus(); return;
  }
  authSeen=true; AUTH.landed=true; S.user=user;
  if(ev==='PASSWORD_RECOVERY'){ AUTH.mode='newPassword'; AUTH.msg=''; }
  if(bootedFor!==user.id){
    bootedFor=user.id; if(user.email) ls.set('dalog.email', user.email); AUTH.pending=null;
    loadRefsFromCache(); render(); await bootstrap(); if(!typing()) render();
    if(LANDING && LANDING.pending && LANDING.type==='signup') toast('Email confirmed. You are signed in.', 4500);
  } else if(ev==='PASSWORD_RECOVERY') render();
}
async function bootstrap(){
  try{ await loadRefs(); await flush(); await loadActive(); await loadLog(); }
  catch(e){ console.warn('bootstrap', e); if(!isNetErr(e)) toast('Could not load your data: '+(e.message||e), 5000); }
  S.ready=true;
}

// ====================================================================
// HOME
// ====================================================================
const catName = id => { const c=S.categories.find(x=>x.id===id); return c?c.name:'Task'; };
const tripKm = t => t.distance_km ?? t.business_km ?? t.routed_km;
function renderHome(){
  const t=S.activeTrip, k=S.activeTask, failed=ls.get(FAILED,[]).length;
  const today=localDate(); const tt=S.log.trips.filter(x=>x.trip_date===today&&x.status==='complete'&&x.trip_type==='work'); const tk=S.log.tasks.filter(x=>localDate(x.started_at)===today&&x.status==='complete');
  const tkm=tt.reduce((s,x)=>s+Number(tripKm(x)||0),0);
  const tms=tk.reduce((s,x)=>s+(new Date(x.ended_at||x.started_at)-new Date(x.started_at)),0);
  const steps=[['Vehicle and its value', !!(S.vehicle && S.vehicle.value_rands!=null)], ['Tax year and opening odometer', S.taxYears.some(y=>y.opening_km!=null)], ['Home and the municipal offices as named places', ['home','municipal_offices'].every(pt=>S.places.some(p=>p.place_type===pt))]];
  const todo=steps.filter(s=>!s[1]).length;
  let tripCard='';
  if(t && t.ended_at){
    tripCard=`<div class="card active-card ${h(t.trip_type)}"><div class="row"><span class="pill ${h(t.trip_type)}">${t.trip_type==='work'?'Work trip':'Personal trip'}</span><span class="small muted">${fmtTime(t.started_at)}–${fmtTime(t.ended_at)} · ${t.routed_km!=null?fmtKm(t.routed_km)+' km measured':'distance not measured'}</span></div>
      <p style="margin:10px 0">Stopped, not yet saved. ${t.trip_type==='work'?'Add the reason to finish it.':'Confirm to finish it.'}</p>
      <button class="btn primary block xl" data-action="completeTrip">Complete trip details</button></div>`;
  } else if(t){
    tripCard=`<div class="card active-card ${h(t.trip_type)}"><div class="row"><span class="pill ${h(t.trip_type)}">${t.trip_type==='work'?'Work trip':'Personal trip'}</span><span class="small muted">started ${fmtTime(t.started_at)}${t.start_lat!=null?` · GPS ±${h(t.start_accuracy_m ?? '?')} m`:' · no GPS fix'}</span></div>
      <div class="timer" data-since="${h(t.started_at)}" style="margin:10px 0">00:00:00</div>
      <button class="btn primary block xl" data-action="stopTrip">Stop trip</button></div>`;
  }
  $('#main').innerHTML=`<div class="stack">
    ${failed?`<div class="banner danger">${failed} change${failed>1?'s':''} could not be saved to the server. <a href="#settings">See Settings → Sync</a>.</div>`:''}
    ${todo&&S.ready?`<div class="card stack"><h2>Finish setting up · ${steps.length-todo} of ${steps.length} done</h2><div class="list">${steps.map(([l,ok])=>`<div class="item"><span aria-hidden="true">${ok?'✓':'○'}</span><span class="grow ${ok?'muted':''}">${h(l)}${ok?' — done':''}</span></div>`).join('')}</div><a class="btn block" href="#settings">Open Settings</a><p class="small muted" style="margin:0">You can log trips and tasks straight away. The SARS export and commute detection need these.</p></div>`:''}
    ${tripCard}
    ${k?`<div class="card active-card task"><div class="row"><span class="pill task">${h(catName(k.category_id))}</span><span class="small muted">${h(k.title||'')}${k.ward?' · '+h(k.ward):''} · ${(k._evidence||[]).length} evidence</span></div>
      <div class="timer" data-since="${h(k.started_at)}" style="margin:10px 0">00:00:00</div>
      <div class="grid2"><button class="btn task" data-action="go" data-to="task">Open task</button><button class="btn" data-action="finishTask">Finish task</button></div></div>`:''}
    ${!t?`<button class="btn primary block xl" data-action="startTrip" data-type="work"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14l-1.5-6h-11z"/><path d="M7 11l1.5-4h7L17 11"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>Start work trip</button>
      <div class="grid2"><button class="btn personal" data-action="startTrip" data-type="personal">Start personal trip</button><button class="btn" data-action="manualTrip">Add a past trip</button></div>`:''}
    ${!k?`<button class="btn task block xl" data-action="go" data-to="task-start"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Start DA task</button>`:''}
    <div class="grid2"><button class="btn" data-action="newExpense">Add expense</button><button class="btn" data-action="go" data-to="evidence">Add evidence</button></div>
    <div class="card"><h2>Today</h2><dl class="kv"><dt>Work trips</dt><dd>${tt.length} · ${fmtKm(tkm)} km</dd><dt>Tasks finished</dt><dd>${tk.length} · ${fmtH(tms)}</dd></dl></div>
  </div>`;
}

// ---- actions (event delegation) --------------------------------------------------------------
const ACTIONS = {
  go: b => go(b.dataset.to),
  startTrip: b => startTrip(b.dataset.type),
  stopTrip: () => stopTrip(),
  completeTrip: () => completeTrip(),
  discardTrip: () => discardTrip(),
  manualTrip: () => { S.edit={id:uuid(), _new:true, entry_mode:'manual', trip_type:'work', stream:'3701', trip_date:localDate(), vehicle_id:S.vehicle?S.vehicle.id:null}; go('trip'); },
  finishTask: () => finishTask(),
  discardTask: () => discardTask(),
  startTask: b => startTask(b.dataset.cat),
  evPhoto: () => $('#evFile').click(),
  evNote: () => evidencePrompt('note'),
  evRef: () => evidencePrompt('reference'),
  openTrip: b => { const t=S.log.trips.find(x=>x.id===b.dataset.id); if(t){ S.edit={...t}; go('trip'); } },
  openTaskDetail: b => { S.taskDetail=S.log.tasks.find(x=>x.id===b.dataset.id)||null; if(S.taskDetail) go('task-detail'); },
  openExpense: b => { S.editExpense=S.log.expenses.find(x=>x.id===b.dataset.id)||null; go('expense'); },
  newExpense: () => { S.editExpense=null; go('expense'); },
  chip: b => { const inp=$('#'+b.dataset.for); if(inp){ inp.value=b.dataset.val; inp.dispatchEvent(new Event('input',{bubbles:true})); } },
  copyText: async b => { const el=$('#'+b.dataset.for); try{ await navigator.clipboard.writeText(el.textContent); toast('Copied'); }catch(err){ const r=document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Selected — copy it from the menu'); } },
  exportLogbook: () => exportLogbook(),
  exportWork: () => exportWork(),
  loadSummary: () => loadSummary(),
  buildMonth: () => buildMonthSummary(),
  reloadLog: async () => { busy('Loading…'); try{ await flush(); await loadLog(); } finally { busy(null); } render(); },
  addPlace: b => addPlaceHere(b.dataset.type),
  delPlace: async b => { await write({type:'delete',table:'places',id:b.dataset.id}); S.places=S.places.filter(p=>p.id!==b.dataset.id); render(); },
  signOut: async () => { const c=$('#confirmSignOut'); if(ls.get(OUTBOX,[]).length && !(c && c.checked)){ render(); return toast('Unsynced changes would be lost. Tick the box to sign out anyway.', 5000); } await sb.auth.signOut(); for(const k of ['dalog.refs','dalog.logcache','dalog.activeTrip','dalog.activeTask',OUTBOX,FAILED]) ls.del(k); S.activeTrip=null; S.activeTask=null; S.log={trips:[],tasks:[],expenses:[],evidence:[]}; AUTH.mode='signin'; AUTH.msg=''; AUTH.pending=null; AUTH.email=ls.get('dalog.email',''); if(location.hash && location.hash!=='#home') location.hash='#home'; },
  assignTrips: async () => { const {error,count}=await sb.from('trips').update({vehicle_id:S.vehicle.id},{count:'exact'}).is('vehicle_id',null); if(error) throw error; toast(`Attached ${count||0} trip${count===1?'':'s'} to ${S.vehicle.name}`); await loadLog(); },
  retryFailed: async () => { const f=ls.get(FAILED,[]); ls.set(FAILED,[]); const q=ls.get(OUTBOX,[]); ls.set(OUTBOX,[...f.map(x=>({...x.op,tries:0})), ...q]); await flush(); render(); },
  clearFailed: () => { if(!$('#confirmClear').checked) return toast('Tick the box to discard these changes'); ls.set(FAILED,[]); render(); },
  deleteTrip: async () => { if(!S.edit || !$('#confirmDel').checked) return toast('Tick the confirmation box first'); await write({type:'delete',table:'trips',id:S.edit.id}); S.log.trips=S.log.trips.filter(x=>x.id!==S.edit.id); saveLog(); S.edit=null; toast('Trip deleted (the audit history keeps a copy)'); go('log'); },
  deleteExpense: async () => { if(!S.editExpense || !$('#confirmDel').checked) return toast('Tick the confirmation box first'); await write({type:'delete',table:'expenses',id:S.editExpense.id}); S.log.expenses=S.log.expenses.filter(x=>x.id!==S.editExpense.id); saveLog(); S.editExpense=null; go('expenses'); },
  addCat: async () => { const name=$('#newCat').value.trim(); if(!name) return; const row={id:uuid(),name,sort_order:S.categories.length+1,active:true}; await write({type:'insert',table:'task_categories',data:row}); S.categories.push(row); render(); },
  rmCat: async b => { await write({type:'update',table:'task_categories',id:b.dataset.id,data:{active:false}}); S.categories=S.categories.filter(c=>c.id!==b.dataset.id); render(); },
  changePass: async () => { const p=$('#newPass').value; if(p.length<8) return toast('At least 8 characters'); const {error}=await sb.auth.updateUser({password:p}); if(error) throw error; $('#newPass').value=''; toast('Password updated'); }
};
// One handler at a time per action / form: a double tap must not create two records.
const inFlight = new Set();
async function once(key, fn){ if(inFlight.has(key)) return; inFlight.add(key); try { await fn(); } finally { inFlight.delete(key); } }
document.addEventListener('click', guard(async e=>{
  const a=e.target.closest('[data-auth]'); if(a){ const f=AUTH_ACTIONS[a.dataset.auth]; if(f) await (a.dataset.auth==='togglePw' ? f(a) : once('auth', ()=>f(a))); return; }
  const b=e.target.closest('[data-action]'); if(!b || b.disabled) return;
  const fn=ACTIONS[b.dataset.action]; if(fn) await once('a:'+b.dataset.action, ()=>fn(b));
}));
document.addEventListener('submit', guard(async e=>{ e.preventDefault(); const fn=FORMS[e.target.id]; if(fn) await once(/^(authForm|forgotForm|newPassForm)$/.test(e.target.id)?'auth':'f:'+e.target.id, ()=>fn(e.target)); }));

// ====================================================================
// TRIPS
// ====================================================================
const cleanRow = o => { const r={}; for(const [k,v] of Object.entries(o)) if(!k.startsWith('_')) r[k]=v; return r; };
async function startTrip(type){
  if(S.activeTrip) return toast('A trip is already running');
  busy('Getting GPS fix…', gpsSkip); const fix=await getFix(); busy(null);
  const startedAt=new Date().toISOString();
  const trip={id:uuid(), trip_type:type, status:'active', entry_mode:'live', stream:'3701', started_at:startedAt, trip_date:localDate(startedAt), vehicle_id:S.vehicle?S.vehicle.id:null,
    start_lat:fix?fix.lat:null, start_lng:fix?fix.lng:null, start_accuracy_m:fix?fix.acc:null};
  S.activeTrip={...trip}; ls.set('dalog.activeTrip',S.activeTrip); render();
  const r=await write({type:'insert',table:'trips',data:trip});
  toast((type==='work'?'Work':'Personal')+' trip started'+(fix?'':' — no GPS fix, type the start address when you stop')+(r.queued?' (saved on phone, will sync)':''), fix?2800:5000);
}
async function stopTrip(){
  const t=S.activeTrip; if(!t) return; if(t.ended_at) return completeTrip();
  busy('Getting end position…', gpsSkip); const end=await getFix(); const endedAt=new Date().toISOString();
  const start = t.start_lat!=null ? {lat:t.start_lat,lng:t.start_lng} : null;
  busy('Measuring route…');
  const routeP=routeKm(start,end); const fromName=t.from_text || await placeName(start); const toName=await placeName(end); const route=await routeP;
  busy(null);
  // Persist both pins the moment Stop is tapped, so an interruption before the form is saved loses nothing.
  const stop={ended_at:endedAt, end_lat:end?end.lat:null, end_lng:end?end.lng:null, end_accuracy_m:end?end.acc:null,
    routed_km:route.km, straight_line_km:route.straight, km_source:route.source, from_text:fromName||null, to_text:toName||null,
    origin_type:t.origin_type||(nearestPlace(start)||{}).place_type||null, destination_type:(nearestPlace(end)||{}).place_type||null};
  Object.assign(t, stop); ls.set('dalog.activeTrip',t);
  try{ await write({type:'upsert',table:'trips',data:cleanRow(t)}); }catch(e){ console.warn('stop not saved yet', e); }
  completeTrip();
}
function completeTrip(){ const t=S.activeTrip; if(!t) return; S.edit={...t, distance_km:t.distance_km ?? t.routed_km, _completing:true}; go('trip'); }
async function discardTrip(){
  const t=S.activeTrip; if(!t) return; if(!$('#confirmDiscard') || !$('#confirmDiscard').checked) return toast('Tick the confirmation box first');
  await write({type:'upsert',table:'trips',data:{...cleanRow(t), status:'discarded', ended_at:t.ended_at||new Date().toISOString()}});
  S.activeTrip=null; ls.del('dalog.activeTrip'); S.edit=null; toast('Trip discarded'); go('home');
}
function renderTripForm(){
  const t=S.edit; if(!t){ go('home'); return; }
  const completing=!!t._completing, isNew=!!t._new, work=t.trip_type==='work', manual=t.entry_mode==='manual';
  const recent=[...new Set(S.log.trips.map(x=>x.reason).filter(Boolean))].slice(0,8);
  const opts=(list,sel)=>list.map(([v,l])=>`<option value="${h(v)}" ${sel===v?'selected':''}>${h(l)}</option>`).join('');
  const kmNote = t.km_source==='osrm' ? `Road distance between your two pins (straight line ${fmtKm(t.straight_line_km)} km). It misses detours — correct it or enter odometer readings.`
    : t.km_source==='estimate' ? `Estimate only: straight line × ${CONFIG.estimateFactor}, because the routing service was unreachable. Check it against the odometer.`
    : t.km_source==='odometer' ? 'From your odometer readings.' : 'Enter the distance, or both odometer readings.';
  const head = manual
    ? `<div class="row"><span class="pill ${h(t.trip_type)}">${work?'Work trip':'Personal trip'}</span><span class="pill warn">entered by hand</span></div>`
    : `<div class="row"><span class="pill ${h(t.trip_type)}">${work?'Work trip':'Personal trip'}</span><span class="small muted">${fmtDateLong(t.trip_date)} · ${fmtTime(t.started_at)}–${fmtTime(t.ended_at)}${t.start_lat==null?' · no start GPS':''}${t.end_lat==null?' · no end GPS':''}</span></div>`;
  const tasks=S.log.tasks.concat(S.activeTask?[S.activeTask]:[]).filter((x,i,arr)=>arr.findIndex(y=>y.id===x.id)===i).slice(0,20);
  $('#main').innerHTML=`<form id="tripForm" class="stack" novalidate>
    ${head}
    ${manual?`<div class="card stack"><div class="grid2">
        <label class="f">Date of the trip<input class="input" type="date" id="trip_date" value="${h(t.trip_date)}" max="${localDate()}"></label>
        <label class="f">Type<select id="trip_type" ${isNew?'':'disabled'}><option value="work" ${work?'selected':''}>Work</option><option value="personal" ${work?'':'selected'}>Personal</option></select></label></div>
        <p class="small muted">Hand-entered trips are marked as such in the export, with the time you captured them. Log on the day where you can.</p></div>`:''}
    <div class="card stack">
      <div class="grid2">
        <label class="f">From<input class="input" id="from_text" value="${h(t.from_text||'')}" placeholder="Where you started" autocomplete="off"></label>
        <label class="f">Origin type<select id="origin_type">${opts([['','—'],...PLACE_TYPES],t.origin_type||'')}</select></label>
        <label class="f">To<input class="input" id="to_text" value="${h(t.to_text||'')}" placeholder="Where you went" autocomplete="off"></label>
        <label class="f">Destination type<select id="destination_type">${opts([['','—'],...PLACE_TYPES],t.destination_type||'')}</select></label>
      </div>
      <div id="reasonWrap" class="stack" ${work?'':'hidden'}><label class="f">Reason for the trip (SARS requires it)<input class="input" id="reason" value="${h(t.reason||'')}" placeholder="e.g. Council meeting, Ward 10 site visit" autocomplete="off"></label>
      ${recent.length?`<div class="chips">${recent.map(r=>`<button type="button" class="chip" data-action="chip" data-for="reason" data-val="${h(r)}">${h(r)}</button>`).join('')}</div>`:''}</div>
    </div>
    <div class="card stack">
      <label class="f">Distance (km)<input class="input num" id="distance_km" type="number" step="0.1" min="0" inputmode="decimal" value="${h(t.distance_km ?? '')}"><span class="small muted">${kmNote}</span></label>
      <div id="overrideWrap" hidden><label class="f">Why does it differ from the measured ${fmtKm(t.routed_km)} km?<input class="input" id="km_override_reason" value="${h(t.km_override_reason||'')}" placeholder="e.g. detour via Ikageng" autocomplete="off"></label></div>
      <div class="grid2">
        <label class="f">Odometer at start (optional)<input class="input num" id="opening_km" type="number" inputmode="numeric" min="0" value="${h(t.opening_km ?? '')}"></label>
        <label class="f">Odometer at end (optional)<input class="input num" id="closing_km" type="number" inputmode="numeric" min="0" value="${h(t.closing_km ?? '')}"></label>
      </div>
    </div>
    <div id="workWrap" class="card stack" ${work?'':'hidden'}>
      <label class="f">Claim under<select id="stream"><option value="3701" ${t.stream!=='3708'?'selected':''}>3701 travel allowance — by kilometre (usual)</option><option value="3708" ${t.stream==='3708'?'selected':''}>3708 public office allowance — actual cost (log the cost as an expense)</option></select></label>
      <label class="f">Linked task (optional)<select id="task_session_id"><option value="">—</option>${tasks.map(k=>`<option value="${h(k.id)}" ${t.task_session_id===k.id?'selected':''}>${h(fmtDate(localDate(k.started_at)))} · ${h(catName(k.category_id))}${k.title?' · '+h(k.title):''}</option>`).join('')}</select></label>
      <div class="grid2"><label class="f">Fuel &amp; oil paid (R, optional)<input class="input num" id="fuel_oil_rands" type="number" step="0.01" min="0" inputmode="decimal" value="${h(t.fuel_oil_rands ?? '')}"></label><label class="f">Repairs &amp; maintenance (R, optional)<input class="input num" id="repairs_maintenance_rands" type="number" step="0.01" min="0" inputmode="decimal" value="${h(t.repairs_maintenance_rands ?? '')}"></label></div>
    </div>
    <button class="btn primary block xl" type="submit">${completing||isNew?'Save trip':'Save changes'}</button>
    ${completing?`<div class="card"><label class="row"><input type="checkbox" id="confirmDiscard"> <span>Discard this trip (the audit history keeps a copy)</span></label><button type="button" class="btn danger block" data-action="discardTrip" style="margin-top:8px">Discard trip</button></div>`
      : isNew?'' : `<div class="card"><label class="row"><input type="checkbox" id="confirmDel"> <span>Delete this trip (the audit history keeps a copy)</span></label><button type="button" class="btn danger block" data-action="deleteTrip" style="margin-top:8px">Delete trip</button></div>`}
  </form>`;
  const km=$('#distance_km'), ow=$('#overrideWrap'), ok=$('#opening_km'), ck=$('#closing_km');
  const odoKm=()=> (ok.value!=='' && ck.value!=='' && Number(ck.value)>=Number(ok.value)) ? Math.round((Number(ck.value)-Number(ok.value))*10)/10 : null;
  const sync=()=>{ ow.hidden = t.routed_km==null || km.value==='' || Number(km.value)===Number(t.routed_km) || odoKm()===Number(km.value); };
  km.addEventListener('input',sync);
  const odo=()=>{ const d=odoKm(); if(d!=null){ km.value=d.toFixed(1); } sync(); }; ok.addEventListener('input',odo); ck.addEventListener('input',odo);
  const tt=$('#trip_type'); if(tt) tt.addEventListener('change',()=>{ const w=tt.value==='work'; $('#reasonWrap').hidden=!w; $('#workWrap').hidden=!w; });
  sync();
}
FORMS.tripForm = async () => {
  const t=S.edit; if(!t) return; const val=id=>{ const el=$('#'+id); return el ? el.value.trim() : ''; };
  const type = t._new ? val('trip_type') : t.trip_type; const work = type==='work';
  const opening=numOrNull(val('opening_km')), closing=numOrNull(val('closing_km')); const distance=numOrNull(val('distance_km'));
  if(opening!=null && closing!=null && closing<opening) return toast('The end odometer reading is lower than the start reading');
  const odoKm = (opening!=null && closing!=null) ? Math.round((closing-opening)*10)/10 : null;
  const data={ status:'complete', trip_type:type, from_text:val('from_text')||null, to_text:val('to_text')||null, origin_type:val('origin_type')||null, destination_type:val('destination_type')||null,
    distance_km:distance, opening_km:opening, closing_km:closing, km_override_reason:val('km_override_reason')||null };
  if($('#trip_date')) { data.trip_date=val('trip_date'); if(!data.trip_date || data.trip_date>localDate()) return toast('Pick the date of the trip (not in the future)'); }
  if(work){
    Object.assign(data,{ reason:val('reason')||null, stream:val('stream')||'3701', task_session_id:val('task_session_id')||null, fuel_oil_rands:numOrNull(val('fuel_oil_rands')), repairs_maintenance_rands:numOrNull(val('repairs_maintenance_rands')) });
    const missing=[!data.from_text&&'where you started', !data.to_text&&'where you went', !data.reason&&'the reason', distance==null&&'the distance'].filter(Boolean);
    if(missing.length) return toast('SARS needs '+missing.join(', ')+'.', 5000);
  } else { Object.assign(data,{ reason:null, task_session_id:null, fuel_oil_rands:null, repairs_maintenance_rands:null }); }
  if(distance!=null && distance>2000) return toast('That distance looks wrong — over 2 000 km in one trip');
  const differs = t.routed_km!=null && distance!=null && distance!==Number(t.routed_km);
  if(differs && odoKm===distance){ data.km_source='odometer'; if(!data.km_override_reason) data.km_override_reason='Odometer reading'; }
  else if(differs){ if(work && !data.km_override_reason) return toast('Say briefly why the distance differs from the measured one'); data.km_source='manual'; }
  else if(odoKm!=null && odoKm===distance) data.km_source='odometer';
  else data.km_source = t.km_source || 'manual';

  let op;
  if(t._new)            op={type:'insert', table:'trips', data:{id:t.id, entry_mode:'manual', vehicle_id:t.vehicle_id, started_at:new Date().toISOString(), ...data}};
  else if(t._completing) op={type:'upsert', table:'trips', data:{...cleanRow(S.activeTrip||t), ...data}};     // upsert: heals a start that never reached the server
  else                  op={type:'update', table:'trips', id:t.id, data};
  const r=await write(op);
  const merged={...cleanRow(t), ...(op.type==='update'?data:op.data), business_km: work ? distance : 0};
  const i=S.log.trips.findIndex(x=>x.id===t.id); if(i>=0) S.log.trips[i]=merged; else S.log.trips.unshift(merged); saveLog();
  if(t._completing){ S.activeTrip=null; ls.del('dalog.activeTrip'); }
  S.edit=null; toast(r.queued?'Saved on this phone — it will sync when you are online':'Trip saved', r.queued?4500:2800); go(t._completing||t._new?'home':'log');
};

// ====================================================================
// TASKS
// ====================================================================
function renderTaskStart(){
  const wards=[...new Set(S.log.tasks.map(x=>x.ward).filter(Boolean))].slice(0,6);
  $('#main').innerHTML=`<div class="stack">
    <div class="card stack"><label class="f">Title (optional)<input class="input" id="taskTitle" placeholder="e.g. MPAC sitting, flooding inspection" autocomplete="off"></label>
    <label class="f">Ward (optional)<input class="input" id="taskWard" placeholder="e.g. Ward 10" autocomplete="off"></label>${wards.length?`<div class="chips">${wards.map(w=>`<button type="button" class="chip" data-action="chip" data-for="taskWard" data-val="${h(w)}">${h(w)}</button>`).join('')}</div>`:''}</div>
    <h2 class="page">Pick a category to start the timer</h2>
    <div class="stack">${S.categories.map(c=>`<button class="btn task block" data-action="startTask" data-cat="${h(c.id)}">${h(c.name)}</button>`).join('')||'<p class="muted">No categories yet. Add one under Settings.</p>'}</div>
    <p class="small muted">A task can only be finished with at least one piece of evidence: a photo, a note or a reference number.</p>
    <button class="btn ghost block" data-action="go" data-to="task-manual">Log a task that already happened</button>
  </div>`;
}
async function startTask(catId){
  if(S.activeTask) return toast('A task is already running');
  const title=$('#taskTitle').value.trim()||null, ward=$('#taskWard').value.trim()||null;
  busy('Getting location…', gpsSkip); const fix=await getFix({timeout:10000}); busy(null);
  const row={id:uuid(), category_id:catId, title, ward, status:'active', entry_mode:'live', started_at:new Date().toISOString(), start_lat:fix?fix.lat:null, start_lng:fix?fix.lng:null, start_accuracy_m:fix?fix.acc:null, start_place:null};
  S.activeTask={...row,_evidence:[]}; ls.set('dalog.activeTask',S.activeTask);
  const r=await write({type:'insert',table:'task_sessions',data:row}); toast('Task started'+(r.queued?' (saved on phone, will sync)':''));
  go('task');
  placeName(fix).then(guard(async n=>{ if(n && S.activeTask && S.activeTask.id===row.id){ S.activeTask.start_place=n; ls.set('dalog.activeTask',S.activeTask); await write({type:'update',table:'task_sessions',id:row.id,data:{start_place:n}}); if(S.view==='task') render(); } }));
}
function renderTaskManual(){
  const now=new Date(); const hhmm=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#main').innerHTML=`<form id="taskManualForm" class="stack" novalidate>
    <div class="card stack">
      <label class="f">Category<select id="mCat">${S.categories.map(c=>`<option value="${h(c.id)}">${h(c.name)}</option>`).join('')}</select></label>
      <label class="f">Title<input class="input" id="mTitle" placeholder="What it was" autocomplete="off"></label>
      <label class="f">Ward (optional)<input class="input" id="mWard" autocomplete="off"></label>
      <label class="f">Date<input class="input" type="date" id="mDate" value="${localDate()}" max="${localDate()}"></label>
      <div class="grid2"><label class="f">Started<input class="input" type="time" id="mStart" value="${hhmm(new Date(now-3600000))}"></label><label class="f">Ended<input class="input" type="time" id="mEnd" value="${hhmm(now)}"></label></div>
      <label class="f">What happened (kept as the evidence note)<textarea id="mNote" placeholder="Who was there, what was decided, any reference number"></textarea></label>
      <label class="f">Outcome (optional)<input class="input" id="mOutcome" autocomplete="off"></label>
    </div>
    <button class="btn task block xl" type="submit">Save task</button>
    <p class="small muted">Hand-entered tasks are marked as such. You can add photos to it afterwards from the Log.</p>
  </form>`;
}
FORMS.taskManualForm = async () => {
  const v=id=>$('#'+id).value.trim(); const date=v('mDate'), note=v('mNote');
  if(!v('mCat')) return toast('Add a category under Settings first');
  if(!date || date>localDate()) return toast('Pick the date (not in the future)');
  if(!v('mStart') || !v('mEnd')) return toast('Enter the start and end time');
  const started=new Date(`${date}T${v('mStart')}`), ended=new Date(`${date}T${v('mEnd')}`);
  if(!(ended>started)) return toast('The end time must be after the start time');
  if(note.length<5) return toast('Describe what happened — it is the evidence for this task', 4500);
  const id=uuid(); const row={id, category_id:v('mCat'), title:v('mTitle')||null, ward:v('mWard')||null, status:'active', entry_mode:'manual', started_at:started.toISOString(), ended_at:ended.toISOString(), outcome:v('mOutcome')||null};
  await write({type:'insert',table:'task_sessions',data:row});
  const ev=await addEvidence({kind:'note', note, task_session_id:id, noFix:true, quiet:true});
  const r=await write({type:'update',table:'task_sessions',id,data:{status:'complete'}});
  S.log.tasks.unshift({...row,status:'complete'}); if(ev) S.log.evidence.push(ev); saveLog();
  toast(r.queued?'Saved on this phone — it will sync when you are online':'Task saved'); go('log');
};
function evidenceList(list){ return list.length ? `<div class="evlist">${list.map(e=>`<div class="ev">${e.storage_path?`<img data-path="${h(e.storage_path)}" alt="Evidence photo" loading="lazy">`:''}<div class="grow"><b>${h(e.kind)}</b> <span class="muted small">${fmtTime(e.captured_at)}${e.lat!=null?' · GPS':''}</span><div class="small">${h(e.note||e.reference||(e.odometer_km!=null?e.odometer_km+' km':''))}</div></div></div>`).join('')}</div>` : '<p class="small muted">No evidence yet.</p>'; }
async function hydrateImages(){ for(const img of $$('img[data-path]')){ try{ const {data}=await sb.storage.from('evidence').createSignedUrl(img.dataset.path, 3600); if(data && data.signedUrl) img.src=data.signedUrl; }catch(e){} } }
function renderTaskActive(){
  const k=S.activeTask; if(!k){ go('home'); return; }
  $('#main').innerHTML=`<div class="stack">
    <div class="card active-card task"><div class="row"><span class="pill task">${h(catName(k.category_id))}</span><span class="small muted">${h(k.title||'')}${k.ward?' · '+h(k.ward):''}</span></div>
      <div class="timer" data-since="${h(k.started_at)}" style="margin:10px 0">00:00:00</div>
      <div class="small muted">Started ${fmtTime(k.started_at)}${k.start_place?' · '+h(k.start_place):''}</div></div>
    <div class="card stack"><h2>Evidence</h2>${evidenceList(k._evidence||[])}
      <div class="grid2"><button class="btn" data-action="evPhoto">Take photo</button><button class="btn" data-action="evNote">Add note</button><button class="btn" data-action="evRef">Reference no.</button><button class="btn" data-action="go" data-to="evidence">Odometer / receipt</button></div>
      <input type="file" id="evFile" accept="image/*" capture="environment" hidden></div>
    <div class="card stack"><label class="f">Notes<textarea id="taskNotes" placeholder="What happened, who was there">${h(k.notes||'')}</textarea></label><label class="f">Outcome<input class="input" id="taskOutcome" value="${h(k.outcome||'')}" placeholder="e.g. complaint logged, ref 12345" autocomplete="off"></label></div>
    <button class="btn task block xl" data-action="finishTask">Finish task</button>
    <div class="card"><label class="row"><input type="checkbox" id="confirmDiscard"> <span>Discard this task (the audit history keeps a copy)</span></label><button class="btn danger block" data-action="discardTask" style="margin-top:8px">Discard</button></div>
  </div>`;
  // keep typed notes if the screen re-renders or the app is closed before Finish
  for(const [id,key] of [['taskNotes','notes'],['taskOutcome','outcome']]) $('#'+id).addEventListener('input', e=>{ k[key]=e.target.value; ls.set('dalog.activeTask',k); });
  hydrateImages();
}
const evidenceTarget = () => S.view==='task' && S.activeTask ? {task_session_id:S.activeTask.id} : S.view==='task-detail' && S.taskDetail ? {task_session_id:S.taskDetail.id} : {};
document.addEventListener('change', guard(async e=>{
  if(e.target.id!=='evFile') return; const f=e.target.files[0]; if(!f) return; e.target.value='';
  const row=await addEvidence({kind:'photo', file:f, ...evidenceTarget()}); if(row) attachEvidenceLocally(row);
}));
function attachEvidenceLocally(row){ if(S.activeTask && row.task_session_id===S.activeTask.id){ (S.activeTask._evidence=S.activeTask._evidence||[]).push(row); ls.set('dalog.activeTask',S.activeTask); } S.log.evidence.push(row); saveLog(); render(); }
function evidencePrompt(kind){
  const target=evidenceTarget();
  openSheet(`<form id="evQuick" class="stack" novalidate><h3>${kind==='note'?'Add note':'Add reference number'}</h3><label class="f">${kind==='note'?'Note':'Reference (complaint no., minute item, etc.)'}<input class="input" id="evVal" autocomplete="off"></label><button class="btn primary block" type="submit">Save</button></form>`);
  FORMS.evQuick = async () => { const v=$('#evVal').value.trim(); if(!v) return toast('Type something first'); closeSheet(); const row=await addEvidence({kind, [kind==='note'?'note':'reference']:v, ...target}); if(row) attachEvidenceLocally(row); };
}
async function finishTask(){
  const k=S.activeTask; if(!k) return;
  if(!(k._evidence||[]).length){ if(S.view!=='task') go('task'); return toast('Add at least one piece of evidence before finishing', 4000); }
  const data={status:'complete', ended_at:new Date().toISOString(), notes:(k.notes||'').trim()||null, outcome:(k.outcome||'').trim()||null};
  const r=await write({type:'update',table:'task_sessions',id:k.id,data});
  const done={...cleanRow(k),...data}; S.log.tasks.unshift(done); saveLog();
  S.activeTask=null; ls.del('dalog.activeTask'); toast('Task finished'+(r.queued?' (saved on phone, will sync)':'')); go('home');
}
async function discardTask(){ const k=S.activeTask; if(!k) return; if(!$('#confirmDiscard') || !$('#confirmDiscard').checked) return toast('Tick the confirmation box first'); await write({type:'update',table:'task_sessions',id:k.id,data:{status:'discarded',ended_at:new Date().toISOString()}}); S.activeTask=null; ls.del('dalog.activeTask'); go('home'); }
function renderTaskDetail(){
  const k=S.taskDetail; if(!k){ go('log'); return; } const ev=S.log.evidence.filter(e=>e.task_session_id===k.id);
  $('#main').innerHTML=`<div class="stack">
    <div class="card"><div class="row"><span class="pill task">${h(catName(k.category_id))}</span>${k.entry_mode==='manual'?'<span class="pill warn">entered by hand</span>':''}<span class="small muted">${fmtDateLong(localDate(k.started_at))}</span></div>
      <h3 style="margin-top:8px">${h(k.title||catName(k.category_id))}</h3><dl class="kv"><dt>Time</dt><dd>${fmtTime(k.started_at)}–${fmtTime(k.ended_at)} (${fmtH(new Date(k.ended_at||k.started_at)-new Date(k.started_at))})</dd>${k.ward?`<dt>Ward</dt><dd class="text">${h(k.ward)}</dd>`:''}${k.start_place?`<dt>Place</dt><dd class="text">${h(k.start_place)}</dd>`:''}</dl></div>
    <form id="taskEdit" class="card stack" novalidate><label class="f">Notes<textarea id="taskNotes">${h(k._notes ?? k.notes ?? '')}</textarea></label><label class="f">Outcome<input class="input" id="taskOutcome" value="${h(k._outcome ?? k.outcome ?? '')}" autocomplete="off"></label><button class="btn primary block" type="submit">Save</button></form>
    <div class="card stack"><h2>Evidence (${ev.length})</h2>${evidenceList(ev)}<div class="grid2"><button class="btn" data-action="evPhoto">Add photo</button><button class="btn" data-action="evNote">Add note</button></div><input type="file" id="evFile" accept="image/*" capture="environment" hidden></div>
  </div>`;
  // drafts survive the re-render that follows adding evidence
  $('#taskNotes').addEventListener('input', e=>{ k._notes=e.target.value; }); $('#taskOutcome').addEventListener('input', e=>{ k._outcome=e.target.value; });
  hydrateImages();
}
FORMS.taskEdit = async () => { const k=S.taskDetail; if(!k) return; const data={notes:$('#taskNotes').value.trim()||null, outcome:$('#taskOutcome').value.trim()||null}; await write({type:'update',table:'task_sessions',id:k.id,data}); Object.assign(k,data); delete k._notes; delete k._outcome; saveLog(); toast('Saved'); };

// ====================================================================
// EVIDENCE
// ====================================================================
async function compressImage(file){
  try{ const bmp=await createImageBitmap(file); const max=1600; const sc=Math.min(1,max/Math.max(bmp.width,bmp.height)); const c=document.createElement('canvas'); c.width=Math.round(bmp.width*sc); c.height=Math.round(bmp.height*sc); c.getContext('2d').drawImage(bmp,0,0,c.width,c.height); const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.82)); return blob?{blob,mime:'image/jpeg',ext:'jpg'}:null; }
  catch(e){ return null; }
}
async function addEvidence({kind, file, note, reference, odometer_km, trip_id, task_session_id, expense_id, noFix, quiet}){
  const id=uuid(); let storage_path=null, mime=null;
  if(file){
    if(!navigator.onLine){ toast('No signal: photos need a connection. Add a note now and the photo later.',5000); return null; }
    busy('Uploading photo…'); const c=await compressImage(file) || {blob:file, mime:file.type||'image/jpeg', ext:((file.name||'').split('.').pop()||'jpg').toLowerCase()};
    storage_path=`${S.user.id}/${localDate().slice(0,7)}/${id}.${c.ext}`; mime=c.mime;
    const {error}=await sb.storage.from('evidence').upload(storage_path, c.blob, {contentType:mime, upsert:false}); busy(null);
    if(error){ toast('Upload failed: '+error.message,5000); return null; }
  }
  let fix=null; if(!noFix){ busy('Tagging location…', gpsSkip); fix=await getFix({timeout:5000, settle:1500}); busy(null); }
  const row={id, kind, captured_at:new Date().toISOString(), lat:fix?fix.lat:null, lng:fix?fix.lng:null, accuracy_m:fix?fix.acc:null, storage_path, mime_type:mime, note:note||null, reference:reference||null, odometer_km:odometer_km??null, trip_id:trip_id||null, task_session_id:task_session_id||null, expense_id:expense_id||null};
  const r=await write({type:'insert',table:'evidence',data:row}); if(!quiet) toast('Evidence saved'+(r.queued?' (on phone, will sync)':'')); return row;
}
function renderEvidenceForm(){
  const trips=(S.activeTrip?[S.activeTrip]:[]).concat(S.log.trips.slice(0,10)), tasks=(S.activeTask?[S.activeTask]:[]).concat(S.log.tasks.slice(0,10));
  $('#main').innerHTML=`<form id="evForm" class="stack" novalidate>
    <div class="card stack">
      <label class="f">Kind<select id="evKind"><option value="photo">Photo</option><option value="odometer">Odometer reading</option><option value="receipt">Receipt</option><option value="note">Note</option><option value="reference">Reference number</option></select></label>
      <label class="f" id="evFileWrap">Photo<input type="file" id="evFile2" accept="image/*" capture="environment" class="input"></label>
      <label class="f" id="evOdoWrap" hidden>Odometer (km)<input class="input num" id="evOdo" type="number" inputmode="numeric" min="0"></label>
      <label class="f">Note / reference<input class="input" id="evText" placeholder="Optional with a photo" autocomplete="off"></label>
      <label class="f">Link to task<select id="evTask"><option value="">—</option>${tasks.map(k=>`<option value="${h(k.id)}" ${S.activeTask&&S.activeTask.id===k.id?'selected':''}>${h(fmtDate(localDate(k.started_at)))} · ${h(catName(k.category_id))}${k.title?' · '+h(k.title):''}</option>`).join('')}</select></label>
      <label class="f">Link to trip<select id="evTrip"><option value="">—</option>${trips.map(t=>`<option value="${h(t.id)}">${h(fmtDate(t.trip_date))} · ${h(t.from_text||'?')} → ${h(t.to_text||'?')}</option>`).join('')}</select></label>
    </div>
    <button class="btn primary block xl" type="submit">Save evidence</button>
    <p class="small muted">Odometer readings feed the running tax estimate. One on 1 March, one on the last day of February, and one at every fuel stop keeps the logbook honest.</p>
  </form>`;
  $('#evKind').addEventListener('change', e=>{ const k=e.target.value; $('#evFileWrap').hidden = !['photo','odometer','receipt'].includes(k); $('#evOdoWrap').hidden = k!=='odometer'; });
}
FORMS.evForm = async () => {
  const kind=$('#evKind').value, file=$('#evFile2').files[0]||null, text=$('#evText').value.trim();
  if(kind==='odometer' && !$('#evOdo').value) return toast('Enter the odometer reading');
  if(kind!=='odometer' && !file && !text) return toast('Add a photo or some text');
  if(['photo','receipt'].includes(kind) && !file) return toast('Choose or take a photo');
  const row=await addEvidence({kind, file, note: kind==='reference'?null:(text||null), reference: kind==='reference'?text:null, odometer_km: kind==='odometer'?Number($('#evOdo').value):null, task_session_id:$('#evTask').value||null, trip_id:$('#evTrip').value||null});
  if(row){ attachEvidenceLocally(row); go('home'); }
};

// ====================================================================
// EXPENSES
// ====================================================================
const catLabel = v => { const c=EXPENSE_CATS.find(x=>x[0]===v); return c?c[1]:v; };
function renderExpenses(){
  const list=S.log.expenses; const total=list.reduce((s,x)=>s+Number(x.amount_rands),0);
  $('#main').innerHTML=`<div class="stack">
    <button class="btn primary block" data-action="newExpense">Add expense</button>
    <div class="card"><h2>Last 90 days · ${fmtR(total)}</h2><div class="list">${list.length?list.map(x=>`<div class="item" data-action="openExpense" data-id="${h(x.id)}"><div class="grow"><div class="t">${h(catLabel(x.category))}</div><div class="small muted">${fmtDate(x.expense_date)}${x.vendor?' · '+h(x.vendor):''}${x.description?' · '+h(x.description):''}</div></div><div class="r num">${fmtR(x.amount_rands)}<div class="small muted" style="font-family:var(--font)">${h(x.stream)}</div></div></div>`).join(''):'<p class="muted small">Nothing yet. Costs you carry for the office — phone and data, stationery, hospitality at official functions — are logged here against the public office allowance (IRP5 code 3708). Keep the receipt photo with each.</p>'}</div></div>
  </div>`;
}
function renderExpenseForm(){
  const x=S.editExpense||{expense_date:localDate(), stream:'3708', category:'secretarial_stationery_telephone'}; const isNew=!S.editExpense;
  const tasks=(S.activeTask?[S.activeTask]:[]).concat(S.log.tasks.slice(0,15));
  $('#main').innerHTML=`<form id="expForm" class="stack" novalidate>
    <div class="card stack">
      <div class="grid2"><label class="f">Date<input class="input" type="date" id="xDate" value="${h(x.expense_date)}" max="${localDate()}"></label><label class="f">Amount (R)<input class="input num" type="number" step="0.01" min="0" inputmode="decimal" id="xAmt" value="${h(x.amount_rands ?? '')}"></label></div>
      <label class="f">Category<select id="xCat">${EXPENSE_CATS.map(([v,l])=>`<option value="${v}" ${x.category===v?'selected':''}>${h(l)}</option>`).join('')}</select></label>
      <label class="f">Claim under<select id="xStream"><option value="3708" ${x.stream==='3708'?'selected':''}>3708 public office allowance</option><option value="3701" ${x.stream==='3701'?'selected':''}>3701 (vehicle cost record only)</option></select></label>
      <label class="f">Vendor<input class="input" id="xVendor" value="${h(x.vendor||'')}" autocomplete="off"></label>
      <label class="f">What it was for<input class="input" id="xDesc" value="${h(x.description||'')}" autocomplete="off"></label>
      <label class="f">Link to task<select id="xTask"><option value="">—</option>${tasks.map(k=>`<option value="${h(k.id)}" ${x.task_session_id===k.id?'selected':''}>${h(fmtDate(localDate(k.started_at)))} · ${h(catName(k.category_id))}${k.title?' · '+h(k.title):''}</option>`).join('')}</select></label>
      ${isNew?`<label class="f">Receipt photo<input type="file" id="xFile" accept="image/*" capture="environment" class="input"></label>`:''}
    </div>
    <button class="btn primary block xl" type="submit">${isNew?'Save expense':'Save changes'}</button>
    ${isNew?'':`<div class="card"><label class="row"><input type="checkbox" id="confirmDel"> <span>Delete this expense (the audit history keeps a copy)</span></label><button type="button" class="btn danger block" data-action="deleteExpense" style="margin-top:8px">Delete</button></div>`}
  </form>`;
}
FORMS.expForm = async () => {
  const isNew=!S.editExpense; const id=isNew?uuid():S.editExpense.id; const amt=$('#xAmt').value;
  if(!$('#xDate').value) return toast('Pick the date'); if(amt==='' || !(Number(amt)>0)) return toast('Enter the amount');
  if(!$('#xDesc').value.trim()) return toast('Say what it was for — an expense without a purpose will not stand up');
  const data={expense_date:$('#xDate').value, amount_rands:Number(amt), category:$('#xCat').value, stream:$('#xStream').value, vendor:$('#xVendor').value.trim()||null, description:$('#xDesc').value.trim()||null, task_session_id:$('#xTask').value||null};
  const r = isNew ? await write({type:'insert',table:'expenses',data:{id,...data}}) : await write({type:'update',table:'expenses',id,data});
  const file=isNew && $('#xFile').files[0]; if(file){ const ev=await addEvidence({kind:'receipt', file, expense_id:id, task_session_id:data.task_session_id, noFix:true, quiet:true}); if(ev) S.log.evidence.push(ev); }
  const row={id,...data}; const i=S.log.expenses.findIndex(x=>x.id===id); if(i>=0) S.log.expenses[i]={...S.log.expenses[i],...row}; else S.log.expenses.unshift(row); saveLog();
  S.editExpense=null; toast(r.queued?'Saved on this phone — it will sync when you are online':'Expense saved'); go('expenses');
};

// ====================================================================
// LOG
// ====================================================================
function renderLog(){
  const items=[];
  for(const t of S.log.trips) if(t.status==='complete') items.push({d:t.trip_date, ts:t.started_at||'', kind:'trip', t});
  for(const k of S.log.tasks) if(k.status==='complete') items.push({d:localDate(k.started_at), ts:k.started_at, kind:'task', k});
  for(const x of S.log.expenses) items.push({d:x.expense_date, ts:'', kind:'expense', x});
  items.sort((a,b)=> a.d!==b.d ? (a.d<b.d?1:-1) : (a.ts<b.ts?1:a.ts>b.ts?-1:0));
  const evCount=id=>S.log.evidence.filter(e=>e.task_session_id===id).length;
  let out='', last='';
  for(const it of items){
    if(it.d!==last){ out+=`<div class="datehead">${fmtDate(it.d)}</div>`; last=it.d; }
    if(it.kind==='trip'){ const t=it.t; out+=`<div class="card tight" style="margin-bottom:8px" data-action="openTrip" data-id="${h(t.id)}"><div class="row"><span class="pill ${h(t.trip_type)}">${h(t.trip_type)}</span><span class="small muted">${t.entry_mode==='manual'?'entered by hand':fmtTime(t.started_at)+'–'+fmtTime(t.ended_at)}</span><span class="num push">${fmtKm(tripKm(t))} km</span></div><div class="small" style="margin-top:4px">${h(t.from_text||'?')} → ${h(t.to_text||'?')}</div>${t.reason?`<div class="small muted">${h(t.reason)}</div>`:''}</div>`; }
    else if(it.kind==='task'){ const k=it.k; out+=`<div class="card tight" style="margin-bottom:8px" data-action="openTaskDetail" data-id="${h(k.id)}"><div class="row"><span class="pill task">task</span><span class="small muted">${fmtTime(k.started_at)}–${fmtTime(k.ended_at)}${k.entry_mode==='manual'?' · by hand':''}</span><span class="num push">${fmtH(new Date(k.ended_at||k.started_at)-new Date(k.started_at))}</span></div><div class="small" style="margin-top:4px"><b>${h(catName(k.category_id))}</b>${k.title?' · '+h(k.title):''}${k.ward?' · '+h(k.ward):''}</div><div class="small muted">${evCount(k.id)} evidence${k.outcome?' · '+h(k.outcome):''}</div></div>`; }
    else { const x=it.x; out+=`<div class="card tight" style="margin-bottom:8px" data-action="openExpense" data-id="${h(x.id)}"><div class="row"><span class="pill expense">expense</span><span class="small muted">${h(catLabel(x.category))}</span><span class="num push">${fmtR(x.amount_rands)}</span></div>${x.description||x.vendor?`<div class="small muted" style="margin-top:4px">${h([x.vendor,x.description].filter(Boolean).join(' · '))}</div>`:''}</div>`; }
  }
  $('#main').innerHTML=`<div><div class="row"><span class="small muted grow">Last 90 days · ${items.filter(i=>i.kind==='trip').length} trips · ${items.filter(i=>i.kind==='task').length} tasks · ${S.log.expenses.length} expenses</span><button class="btn small" data-action="reloadLog">Refresh</button></div>${out||'<p class="muted" style="margin-top:16px">Nothing logged yet. Start a trip or a task from Home.</p>'}</div>`;
}

// ====================================================================
// EXPORT
// ====================================================================
let xlsxP=null;
function loadXlsx(){ if(window.XLSX) return Promise.resolve(); if(!xlsxP) xlsxP=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='./vendor/xlsx.mini.min.js'; s.onload=()=>res(); s.onerror=()=>{ xlsxP=null; rej(new Error('Could not load the spreadsheet module — check your connection')); }; document.head.appendChild(s); }); return xlsxP; }
function currentTaxYear(){ const lbl=taxYearLabelFor(localDate()); return S.taxYears.find(t=>t.year_label===lbl && (!S.vehicle||t.vehicle_id===S.vehicle.id)) || S.taxYears[0] || null; }
async function loadSummary(){ const sel=$('#tySel'); const id=sel?sel.value:(currentTaxYear()||{}).id; if(!id) return toast('Create a tax year in Settings first'); busy('Calculating…'); const {data,error}=await sb.rpc('sars_summary',{p_tax_year_id:id}); busy(null); if(error) throw error; S.summary=data; S.summaryTaxYearId=id; render(); }
function renderExport(){
  const tys=S.taxYears; const sel=S.summaryTaxYearId||(currentTaxYear()||{}).id; const s=(S.summary && S.summaryTaxYearId===sel) ? S.summary : null;
  const now=new Date();
  $('#main').innerHTML=`<div class="stack">
    <div class="card stack"><h2>SARS travel logbook</h2>
      ${tys.length?`<label class="f">Tax year<select id="tySel">${tys.map(t=>`<option value="${h(t.id)}" ${t.id===sel?'selected':''}>${h(t.year_label)} · ${h((S.vehicles.find(v=>v.id===t.vehicle_id)||{}).name||'')}</option>`).join('')}</select></label>
      <button class="btn" data-action="loadSummary">Calculate</button>`:'<p class="muted small">Add a vehicle and a tax year under Settings first.</p>'}
      ${s?`${s.unassigned_work_trips?`<div class="banner warn">${s.unassigned_work_trips} work trip${s.unassigned_work_trips>1?'s are':' is'} not attached to a vehicle and ${s.unassigned_work_trips>1?'are':'is'} left out. Attach ${s.unassigned_work_trips>1?'them':'it'} under <a href="#settings">Settings → Vehicle</a>.</div>`:''}
      ${s.provisional?`<div class="banner info">Running estimate: the year is not closed, so total km comes from your latest odometer reading (${h(s.odometer.latest)} km) and the fixed cost is pro-rated to today.</div>`:''}
      <dl class="kv">
        <dt>Period</dt><dd class="text">${fmtDate(s.period.from)} – ${fmtDate(s.period.to)}</dd>
        <dt>Odometer open / close</dt><dd>${h(s.odometer.opening ?? '—')} / ${h(s.odometer.closing ?? (s.provisional ? s.odometer.latest+'*' : '—'))}</dd>
        <dt>Total km</dt><dd>${h(s.odometer.total_km ?? '—')}</dd>
        <dt>Business trips</dt><dd>${h(s.trips)}</dd>
        <dt>Business km (all)</dt><dd>${fmtKm(s.business_km.all)}</dd>
        <dt>Home ↔ municipal offices</dt><dd>${fmtKm(s.business_km.home_office_commute)} ${s.business_km.commute_excluded?'(left out)':'(included)'}</dd>
        <dt>Business km claimed</dt><dd>${fmtKm(s.business_km.claimed)}</dd>
        <dt>Vehicle value band</dt><dd>${s.band.max_value?'up to '+fmtR(s.band.max_value):s.band.fixed_cost!=null?'top band':'— (set vehicle value)'}</dd>
        <dt>Rate per km</dt><dd>${s.per_km.total!=null?'R'+Number(s.per_km.total).toFixed(2):'— (needs '+(s.band.fixed_cost==null?'vehicle value':'odometer readings')+')'}</dd>
        <dt>Computed deduction</dt><dd>${fmtR(s.computed_deduction)}</dd>
        <dt>3701 allowance</dt><dd>${fmtR(s.travel_allowance_3701)}</dd>
        <dt><b>${s.provisional?'Estimated':'Allowable'} deduction</b></dt><dd><b>${fmtR(s.allowable_deduction)}</b></dd>
        <dt>3708 expenses logged</dt><dd>${fmtR(s.public_office_3708.expenses_total)} of ${fmtR(s.public_office_3708.allowance)}</dd>
      </dl>
      <p class="small muted">${s.year_label==='2026/27'?'The 2026/27 cost table is a placeholder copied from 2025/26 until SARS publishes its 2026-27 eLogbook. ':''}An estimate for planning, not a tax return. Confirm the treatment with a tax practitioner.</p>
      <button class="btn primary block" data-action="exportLogbook">Download SARS logbook (.xlsx)</button>`:''}
    </div>
    <div class="card stack"><h2>Proof of work</h2>
      <label class="f">Month<input class="input" type="month" id="powMonth" value="${now.getFullYear()}-${pad(now.getMonth()+1)}"></label>
      <button class="btn" data-action="buildMonth">Build month summary</button>
      <div id="powOut"></div>
      <button class="btn primary block" data-action="exportWork">Download proof-of-work workbook (.xlsx)</button>
    </div>
  </div>`;
  const sel2=$('#tySel'); if(sel2) sel2.addEventListener('change',()=>{ S.summary=null; S.summaryTaxYearId=sel2.value; render(); });
}
async function fetchRange(table, col, from, to){ const {data,error}=await sb.from(table).select('*').gte(col,from).lte(col,to).order(col); if(error) throw error; return data; }
function monthRange(){ const m=$('#powMonth').value; if(!m){ toast('Pick a month'); return null; } const from=m+'-01', to=localDate(new Date(Number(m.slice(0,4)), Number(m.slice(5,7)), 0)); return {from,to}; }
async function monthData({from,to}){
  const [tasks,trips,exps,ev]=await Promise.all([fetchRange('task_sessions','started_at',dayStartIso(from),dayEndIso(to)),fetchRange('trips','trip_date',from,to),fetchRange('expenses','expense_date',from,to),fetchRange('evidence','captured_at',dayStartIso(from),dayEndIso(to))]);
  return {tasks:tasks.filter(k=>k.status!=='discarded'), trips:trips.filter(t=>t.status!=='discarded'), exps, ev};
}
async function buildMonthSummary(){
  const range=monthRange(); if(!range) return; busy('Building…');
  try{
    const {tasks,trips,exps,ev}=await monthData(range);
    const done=tasks.filter(k=>k.status==='complete'); const byCat={}; for(const k of done){ const n=catName(k.category_id); const ms=new Date(k.ended_at)-new Date(k.started_at); byCat[n]=byCat[n]||{n:0,ms:0}; byCat[n].n++; byCat[n].ms+=ms; }
    const totalMs=done.reduce((s,k)=>s+(new Date(k.ended_at)-new Date(k.started_at)),0);
    const work=trips.filter(t=>t.trip_type==='work'&&t.status==='complete'); const km=work.reduce((s,t)=>s+Number(tripKm(t)||0),0);
    const wards={}; for(const k of done) if(k.ward){ wards[k.ward]=(wards[k.ward]||0)+1; }
    const label=new Date(range.from+'T00:00:00').toLocaleDateString('en-ZA',{month:'long',year:'numeric'});
    const lines=[`*Activity report — ${label}*`,'',`*Tasks:* ${done.length} sessions, ${fmtH(totalMs)} logged`,...Object.entries(byCat).sort((a,b)=>b[1].ms-a[1].ms).map(([n,v])=>`• ${n}: ${v.n} (${fmtH(v.ms)})`),''];
    if(Object.keys(wards).length) lines.push(`*Wards:* ${Object.entries(wards).map(([w,n])=>`${w} ×${n}`).join(', ')}`);
    lines.push(`*Travel:* ${work.length} work trips, ${fmtKm(km)} km`,`*Evidence items:* ${ev.length}`,`*Expenses (3708):* ${fmtR(exps.filter(x=>x.stream==='3708').reduce((s,x)=>s+Number(x.amount_rands),0))}`);
    const outcomes=done.filter(k=>k.outcome).slice(0,15); if(outcomes.length) lines.push('',...outcomes.map(k=>`• ${fmtDate(localDate(k.started_at))}: ${k.title||catName(k.category_id)} — ${k.outcome}`));
    $('#powOut').innerHTML=`<pre class="copy" id="powText">${h(lines.join('\n'))}</pre><button class="btn block" data-action="copyText" data-for="powText" style="margin-top:8px">Copy for WhatsApp</button>`;
  } finally { busy(null); }
}
async function deliverWorkbook(wb, filename){
  const out=XLSX.write(wb,{bookType:'xlsx',type:'array'}); const type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; const blob=new Blob([out],{type});
  try{ const file=new File([blob],filename,{type}); if(navigator.canShare && navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:filename}); return; } }
  catch(e){ if(e && e.name==='AbortError') return; }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },4000);
}
function flatten(o,p=''){ const out=[]; for(const [k,v] of Object.entries(o||{})){ if(v&&typeof v==='object'&&!Array.isArray(v)) out.push(...flatten(v,p+k+'.')); else out.push([p+k, v==null?'':v]); } return out; }
async function exportLogbook(){
  const id=S.summaryTaxYearId||(currentTaxYear()||{}).id; const ty=S.taxYears.find(t=>t.id===id); if(!ty) return toast('Pick a tax year');
  const p=S.params.find(x=>x.year_label===ty.year_label); if(!p) return toast('No dates on record for '+ty.year_label);
  const v=S.vehicles.find(x=>x.id===ty.vehicle_id)||{};
  busy('Building logbook…');
  try{
    await loadXlsx();
    const {data,error}=await sb.from('v_sars_logbook').select('*').eq('vehicle_id',ty.vehicle_id).gte('Date',p.starts_on).lte('Date',p.ends_on).order('Date'); if(error) throw error;
    const keep=r=>r.stream==='3701' && !(ty.exclude_home_office_commute && r.is_home_office_commute);
    const rows=data.filter(keep), excluded=data.filter(r=>!keep(r));
    const totalBiz=Math.round(rows.reduce((s,r)=>s+Number(r['Total Business Kms']||0),0)*10)/10;
    const head=[['SARS Travel Logbook'],['Year of assessment',ty.year_label,'',`${p.starts_on} to ${p.ends_on}`],['Vehicle',v.name||'','Registration',v.registration||''],
      ['Opening kilometres at the beginning of the year of assessment',ty.opening_km??'',[ty.opening_km_date,ty.opening_km_source].filter(Boolean).join(' · ')],
      ['Closing kilometres at the end of the year of assessment',ty.closing_km??'',ty.closing_km_source||''],
      ['Total kilometres for the year',(ty.opening_km!=null&&ty.closing_km!=null)?ty.closing_km-ty.opening_km:''],['Total business kilometres',totalBiz],[],
      ['Date','Opening Kilometres','Closing Kilometres','Total Business Kms','From','To','Reason','Actual Fuel & Oil Costs (R)','Actual Repairs & Maintenance Costs (R)']];
    const body=rows.map(r=>[r.Date,r['Opening Kilometres']??'',r['Closing Kilometres']??'',Number(r['Total Business Kms']||0),r.From||'',r.To||'',r.Reason||'',r['Actual Fuel & Oil Costs (R)']??'',r['Actual Repairs & Maintenance Costs (R)']??'']);
    const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet([...head,...body,['TOTAL','','',totalBiz]]); ws['!cols']=[{wch:11},{wch:10},{wch:10},{wch:10},{wch:28},{wch:28},{wch:34},{wch:12},{wch:14}]; XLSX.utils.book_append_sheet(wb,ws,'Logbook');
    const det=[['id','date','stream','how_entered','started','ended','from','to','origin_type','destination_type','business_km','routed_km','km_source','record_created_at','left_out_as_commute']];
    for(const r of data) det.push([r.id,r.Date,r.stream,r.entry_mode||'live',r.started_at,r.ended_at,r.From,r.To,r.origin_type,r.destination_type,r['Total Business Kms'],r.routed_km,r.km_source,r.created_at,(ty.exclude_home_office_commute&&r.is_home_office_commute)?'yes':'']);
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(det),'Trip detail');
    if(excluded.length) XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Date','From','To','Reason','Km','Why left out'],...excluded.map(r=>[r.Date,r.From,r.To,r.Reason,r['Total Business Kms'],r.stream==='3708'?'Claimed under 3708 at actual cost':'Home to place of work (private travel)'])]),'Left out');
    if(S.summary && S.summaryTaxYearId===ty.id) XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Summary — an estimate for planning, not a return'],...flatten(S.summary)]),'Summary');
    await deliverWorkbook(wb,`SARS_Logbook_${ty.year_label.replace('/','-')}_${(v.name||'vehicle').replace(/\W+/g,'_')}.xlsx`);
  } finally { busy(null); }
}
async function exportWork(){
  const range=monthRange(); if(!range) return; busy('Building workbook…');
  try{
    await loadXlsx(); const {tasks,trips,exps,ev}=await monthData(range);
    const wb=XLSX.utils.book_new(); const add=(name,rows)=>XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),name);
    add('Tasks',[['Date','Category','Title','Ward','Start','End','Hours','Status','How entered','Place','Evidence count','Outcome','Notes','id'],...tasks.map(k=>[localDate(k.started_at),catName(k.category_id),k.title||'',k.ward||'',fmtTime(k.started_at),fmtTime(k.ended_at),k.ended_at?Math.round((new Date(k.ended_at)-new Date(k.started_at))/36000)/100:'',k.status,k.entry_mode||'live',k.start_place||'',ev.filter(e=>e.task_session_id===k.id).length,k.outcome||'',k.notes||'',k.id])]);
    add('Evidence',[['Captured','Kind','Note','Reference','Odometer','Lat','Lng','Accuracy m','Task id','Trip id','Expense id','File'],...ev.map(e=>[e.captured_at,e.kind,e.note||'',e.reference||'',e.odometer_km??'',e.lat??'',e.lng??'',e.accuracy_m??'',e.task_session_id||'',e.trip_id||'',e.expense_id||'',e.storage_path||''])]);
    add('Trips',[['Date','Type','Stream','How entered','Start','End','From','To','Reason','Km','Km source','Status','id'],...trips.map(t=>[t.trip_date,t.trip_type,t.stream,t.entry_mode||'live',fmtTime(t.started_at),fmtTime(t.ended_at),t.from_text||'',t.to_text||'',t.reason||'',tripKm(t)??'',t.km_source||'',t.status,t.id])]);
    add('Expenses',[['Date','Category','Stream','Amount','Vendor','Description','Task id','id'],...exps.map(x=>[x.expense_date,catLabel(x.category),x.stream,Number(x.amount_rands),x.vendor||'',x.description||'',x.task_session_id||'',x.id])]);
    await deliverWorkbook(wb,`Proof_of_work_${range.from}_${range.to}.xlsx`);
  } finally { busy(null); }
}

// ====================================================================
// SETTINGS
// ====================================================================
function renderSettings(){
  const v=S.vehicle||{}; const failed=ls.get(FAILED,[]); const q=ls.get(OUTBOX,[]);
  // the year shown follows the dropdown: an existing record for that year is loaded, otherwise a blank one is offered
  const lbl=S.settingsYear || (currentTaxYear()||{}).year_label || taxYearLabelFor(localDate());
  const ty=S.taxYears.find(t=>t.year_label===lbl && (!S.vehicle || t.vehicle_id===S.vehicle.id)) || {};
  const p=S.params.find(x=>x.year_label===lbl)||{};
  $('#main').innerHTML=`<div class="stack">
    <form id="vehForm" class="card stack" novalidate><h2>Vehicle</h2>
      <input type="hidden" id="vId" value="${h(v.id||'')}">
      <div class="grid2"><label class="f">Name<input class="input" id="vName" value="${h(v.name||'')}" placeholder="e.g. Polo" autocomplete="off"></label><label class="f">Registration<input class="input" id="vReg" value="${h(v.registration||'')}" autocomplete="off" autocapitalize="characters"></label></div>
      <label class="f">Value when you acquired it (R, incl. VAT)<input class="input num" id="vValue" type="number" inputmode="numeric" min="0" value="${h(v.value_rands ?? '')}"><span class="small muted">Sets the band in the SARS cost table.</span></label>
      <label class="row"><input type="checkbox" id="vMaint" ${v.maintenance_plan?'checked':''}> <span>On a maintenance plan (no maintenance cost claim)</span></label>
      <label class="row"><input type="checkbox" id="vFuel" ${v.employer_pays_fuel?'checked':''}> <span>Someone else pays the fuel (no fuel cost claim)</span></label>
      <button class="btn primary block" type="submit">Save vehicle</button>
      ${S.vehicle?`<button class="btn block" type="button" data-action="assignTrips">Attach unassigned trips to ${h(S.vehicle.name)}</button>`:''}
    </form>
    <form id="tyForm" class="card stack" novalidate><h2>Tax year</h2>
      <input type="hidden" id="tyId" value="${h(ty.id||'')}">
      <label class="f">Year of assessment<select id="tyLabel">${S.params.map(x=>`<option value="${h(x.year_label)}" ${lbl===x.year_label?'selected':''}>${h(x.year_label)} (${h(x.starts_on)} to ${h(x.ends_on)})</option>`).join('')}</select></label>
      <div class="grid2"><label class="f">Opening odometer (km)<input class="input num" id="tyOpen" type="number" inputmode="numeric" min="0" value="${h(ty.opening_km ?? '')}"></label><label class="f">Date of that reading<input class="input" type="date" id="tyOpenDate" value="${h(ty.opening_km_date || p.starts_on || '')}"></label></div>
      <label class="f">Proof of the opening reading<input class="input" id="tyOpenSrc" value="${h(ty.opening_km_source||'')}" placeholder="e.g. photo, service invoice 14 Feb" autocomplete="off"><span class="small muted">SARS asks for the reading on 1 March. If you have none, use the earliest dated reading you can prove, and name the document here.</span></label>
      <div class="grid2"><label class="f">Closing odometer (end Feb)<input class="input num" id="tyClose" type="number" inputmode="numeric" min="0" value="${h(ty.closing_km ?? '')}"></label><label class="f">Proof<input class="input" id="tyCloseSrc" value="${h(ty.closing_km_source||'')}" autocomplete="off"></label></div>
      <div class="grid2"><label class="f">3701 travel allowance (R for the year)<input class="input num" id="ty3701" type="number" inputmode="decimal" min="0" value="${h(ty.travel_allowance_rands ?? '')}"></label><label class="f">3708 public office allowance (R)<input class="input num" id="ty3708" type="number" inputmode="decimal" min="0" value="${h(ty.public_office_allowance_rands ?? '')}"></label></div>
      <label class="f">Months the vehicle was used for business this year<input class="input num" id="tyMonths" type="number" min="1" max="12" inputmode="numeric" value="${h(ty.business_months ?? 12)}"></label>
      <label class="row"><input type="checkbox" id="tyCommute" ${ty.exclude_home_office_commute!==false?'checked':''}> <span>Treat home ↔ municipal offices as private travel (the SARS default)</span></label>
      <button class="btn primary block" type="submit" ${S.vehicle?'':'disabled'}>Save tax year</button>
      ${S.vehicle?'':'<p class="small muted">Save a vehicle first.</p>'}
    </form>
    <div class="card stack"><h2>Named places</h2>
      ${S.places.length?`<div class="list">${S.places.map(pl=>`<div class="item"><div class="grow"><div class="t">${h(pl.name)}</div><div class="small muted">${h((PLACE_TYPES.find(x=>x[0]===pl.place_type)||[])[1]||'')} · within ${h(pl.radius_m)} m</div></div><button class="btn small" data-action="delPlace" data-id="${h(pl.id)}">Remove</button></div>`).join('')}</div>`:'<p class="small muted">Stand at the place and tap its button. Trips that start or end within 250 m are named and typed automatically — that is how the app tells a commute from a business trip.</p>'}
      <div class="chips">${PLACE_TYPES.map(([val,l])=>`<button class="chip" data-action="addPlace" data-type="${val}">＋ ${h(l)} here</button>`).join('')}</div>
    </div>
    <div class="card stack"><h2>Task categories</h2>
      <div class="list">${S.categories.map(c=>`<div class="item"><div class="grow">${h(c.name)}</div><button class="btn small" data-action="rmCat" data-id="${h(c.id)}">Hide</button></div>`).join('')}</div>
      <div class="row"><input class="input grow" id="newCat" placeholder="New category" autocomplete="off"><button class="btn" data-action="addCat">Add</button></div>
    </div>
    <div class="card stack"><h2>Sync</h2><div class="small">${q.length} waiting to send · ${failed.length} refused by the server</div>
      ${failed.length?`<div class="banner danger small">${failed.map(f=>h(f.op.table)+': '+h(f.error)).join('<br>')}</div><div class="grid2"><button class="btn" data-action="retryFailed">Try again</button><button class="btn danger" data-action="clearFailed">Discard them</button></div><label class="row small"><input type="checkbox" id="confirmClear"> <span>I understand discarded changes are lost</span></label>`:''}
      <div class="small muted">Trips, tasks and notes made without signal are kept on this phone and sent in order when you are back online. Photos need a connection at the time.</div></div>
    <div class="card stack"><h2>Account</h2><div class="small">${h(S.user.email||'')}</div>
      <div class="row"><input class="input grow" type="password" id="newPass" placeholder="New password" autocomplete="new-password"><button class="btn" data-action="changePass">Change</button></div>
      ${q.length?`<label class="row small"><input type="checkbox" id="confirmSignOut"> <span>Sign out even though ${q.length} change${q.length>1?'s have':' has'} not synced</span></label>`:''}
      <button class="btn block" data-action="signOut">Sign out</button>
      <div class="small muted">DA Logbook v${CONFIG.version}</div></div>
  </div>`;
  $('#tyLabel').addEventListener('change', e=>{ S.settingsYear=e.target.value; render(); });
}
FORMS.vehForm = async () => {
  const isNew=!$('#vId').value; const id=$('#vId').value||uuid(); const name=$('#vName').value.trim(); if(!name) return toast('Give the vehicle a name');
  const data={name, registration:$('#vReg').value.trim()||null, value_rands:numOrNull($('#vValue').value), maintenance_plan:$('#vMaint').checked, employer_pays_fuel:$('#vFuel').checked, active:true};
  if(isNew){ const {error}=await sb.from('vehicles').insert({id,...data}); if(error) throw error; if(!S.vehicles.length){ await sb.from('trips').update({vehicle_id:id}).is('vehicle_id',null); if(S.activeTrip && !S.activeTrip.vehicle_id){ S.activeTrip.vehicle_id=id; ls.set('dalog.activeTrip',S.activeTrip); } } }
  else { const {error}=await sb.from('vehicles').update(data).eq('id',id); if(error) throw error; }
  await loadRefs(); toast('Vehicle saved'); render();
};
FORMS.tyForm = async () => {
  if(!S.vehicle) return; const id=$('#tyId').value||uuid(); const isNew=!$('#tyId').value;
  const open=numOrNull($('#tyOpen').value), close=numOrNull($('#tyClose').value); if(open!=null && close!=null && close<open) return toast('The closing reading is lower than the opening reading');
  const months=Number($('#tyMonths').value||12); if(!(months>=1 && months<=12)) return toast('Months must be between 1 and 12');
  const data={vehicle_id:S.vehicle.id, year_label:$('#tyLabel').value, opening_km:open, opening_km_date:$('#tyOpenDate').value||null, opening_km_source:$('#tyOpenSrc').value.trim()||null, closing_km:close, closing_km_source:$('#tyCloseSrc').value.trim()||null, travel_allowance_rands:numOrNull($('#ty3701').value), public_office_allowance_rands:numOrNull($('#ty3708').value), business_months:months, exclude_home_office_commute:$('#tyCommute').checked};
  const r = isNew ? await sb.from('tax_years').upsert({id,...data},{onConflict:'vehicle_id,year_label'}) : await sb.from('tax_years').update(data).eq('id',id);
  if(r.error) throw r.error; S.summary=null; await loadRefs(); toast('Tax year saved'); render();
};
async function addPlaceHere(type){
  busy('Getting location…', gpsSkip); const fix=await getFix(); busy(null); if(!fix) return toast('No GPS fix — try again outside');
  const label=(PLACE_TYPES.find(x=>x[0]===type)||[])[1]||type;
  openSheet(`<form id="placeForm" class="stack" novalidate><h3>Name this place</h3><label class="f">Name<input class="input" id="plName" value="${h(label)}" autocomplete="off"></label><div class="small muted">${fmtCoord(fix)} · ±${fix.acc} m</div><button class="btn primary block" type="submit">Save</button></form>`);
  FORMS.placeForm = async () => { const name=$('#plName').value.trim()||label; const row={id:uuid(), name, place_type:type, lat:fix.lat, lng:fix.lng, radius_m:250}; closeSheet(); await write({type:'insert',table:'places',data:row}); S.places.push(row); toast('Place saved'); render(); };
}

// ---- bottom sheet ---------------------------------------------------------------------------
function openSheet(html){ closeSheet(); const sc=document.createElement('div'); sc.className='scrim'; sc.id='scrim'; sc.addEventListener('click',closeSheet); const sh=document.createElement('div'); sh.className='sheet'; sh.id='sheet'; sh.setAttribute('role','dialog'); sh.innerHTML=html; document.body.append(sc,sh); const f=$('input',sh); if(f) setTimeout(()=>f.focus(),50); }
function closeSheet(){ const a=$('#scrim'), b=$('#sheet'); if(a) a.remove(); if(b) b.remove(); }

// ====================================================================
// BOOT
// ====================================================================
renderSync();
try{ if(navigator.serviceWorker && (location.protocol==='https:' || location.hostname==='localhost')) navigator.serviceWorker.register('./sw.js').catch(()=>{}); }catch(e){}
// onAuthStateChange delivers INITIAL_SESSION (signed in or not); these cover the cases where it is slow or never arrives.
setTimeout(()=>{ if(!S.user && $('#main').textContent.trim()==='Loading…'){ render(); loadOwnerStatus(); } }, 1500);
setTimeout(()=>{ if(!S.user && LANDING && LANDING.pending && !AUTH.landed){ AUTH.landed=true; authNote('That link could not sign you in. Sign in with your password instead.'); render(); } }, 8000);
