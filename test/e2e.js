// End-to-end test: the real app + real supabase-js in headless Chromium, served over http, against the mocked Supabase API.
// Usage: node test/e2e.js [path-to-xlsx-node-module]      Exit code 0 = all checks passed.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const { createMock } = require('./mock-supabase');
const XLSX = require(process.argv[2] || 'xlsx');
const WEB = path.resolve(__dirname, '../docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(WEB, p);
    if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const BASE = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();

  async function session({ sw = 'block', scheme = 'light', mockOpts = {} } = {}) {
    const mock = createMock(mockOpts);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: sw, acceptDownloads: true,
      geolocation: { latitude: -26.7145, longitude: 27.0973 }, permissions: ['geolocation'], timezoneId: 'Africa/Johannesburg', locale: 'en-ZA' });
    const page = await ctx.newPage(); const errors = []; const stray = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) errors.push('console: ' + m.text()); });
    await ctx.route(/supabase\.co/, mock.handle);
    await ctx.route(/router\.project-osrm\.org/, r => mock.state.offline ? r.abort('internetdisconnected') : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'Ok', routes: [{ distance: 4321 }] }) }));
    await ctx.route(/nominatim\.openstreetmap\.org/, r => mock.state.offline ? r.abort('internetdisconnected') : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ address: { road: 'Wolmarans St', suburb: 'Tlokwe Ward 24', neighbourhood: 'Potchefstroom Central', city: 'Potchefstroom' } }) }));   // suburb as the live service really returns it
    page.on('request', r => { const h = new URL(r.url()).hostname; if (!/^(localhost|nnwiuooawsyfspkqerhv\.supabase\.co|router\.project-osrm\.org|nominatim\.openstreetmap\.org)$/.test(h) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) stray.push(r.url()); });
    const ui = {
      text: async () => (await page.textContent('#main')).replace(/\s+/g, ' ').trim(),
      toast: async () => (await page.textContent('#toast')).trim(),
      ls: k => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), k),
      act: async (name, extra = '') => { await page.click(`[data-action="${name}"]${extra}`); },
      settle: (ms = 350) => page.waitForTimeout(ms),
      signIn: async () => { await page.goto(BASE); await page.waitForSelector('#authEmail'); await page.fill('#authEmail', 'test@example.com'); await page.fill('#authPass', 'correct-horse'); await page.click('#authForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); },
      offline: async on => { mock.state.offline = on; await ctx.setOffline(on); await page.waitForTimeout(250); },
    };
    return { mock, ctx, page, errors, stray, ui };
  }

  // =================================================================== main flow
  {
    const { mock, ctx, page, errors, stray, ui } = await session(); const st = mock.store;
    console.log('\nAuth');
    await page.goto(BASE); await page.waitForSelector('#authEmail');
    await ui.settle(600);
    check('sign-in screen renders, nav hidden', (await page.textContent('#authForm h3')) === 'Sign in' && !(await page.isVisible('#nav')));
    check('with an owner on record, Create account is not offered', /already has its owner account/.test(await ui.text()) && (await page.locator('[data-mode="create"]').count()) === 0, await ui.text());
    await page.fill('#authEmail', 'test@example.com'); await page.fill('#authPass', 'wrong-password'); await page.click('#authForm button[type=submit]'); await ui.settle(500);
    check('wrong password gets a plain-language message', (await page.textContent('#authMsg')) === 'That email and password do not match.', await page.textContent('#authMsg'));
    await page.click('[data-auth="togglePw"]');
    check('Show reveals the password without clearing it', (await page.getAttribute('#authPass', 'type')) === 'text' && (await page.inputValue('#authPass')) === 'wrong-password' && (await page.textContent('[data-auth="togglePw"]')) === 'Hide');
    await page.fill('#authPass', 'correct-horse'); await page.click('#authForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]', { timeout: 8000 });
    check('sign-in reaches Home with the real client library', (await ui.text()).includes('Start work trip'));

    console.log('Settings');
    await page.goto(BASE + '#settings'); await page.waitForSelector('#vehForm');
    await page.fill('#vName', 'Polo'); await page.fill('#vValue', '250000'); await page.click('#vehForm button[type=submit]'); await ui.settle(600);
    check('vehicle saved', st.vehicles.length === 1 && st.vehicles[0].value_rands === 250000, JSON.stringify(st.vehicles));
    await page.fill('#tyOpen', '120000'); await page.fill('#ty3701', '79470'); await page.fill('#ty3708', '43200'); await page.click('#tyForm button[type=submit]'); await ui.settle(600);
    check('tax year saved with opening reading and its date', st.tax_years.length === 1 && st.tax_years[0].opening_km === 120000 && st.tax_years[0].opening_km_date === '2026-03-01' && st.tax_years[0].travel_allowance_rands === 79470, JSON.stringify(st.tax_years));
    await ui.act('addPlace', '[data-type="home"]'); await page.waitForSelector('#placeForm'); await page.click('#placeForm button[type=submit]'); await ui.settle(500);
    check('named place saved at the current position', st.places.length === 1 && st.places[0].place_type === 'home' && Math.abs(st.places[0].lat + 26.7145) < 1e-6, JSON.stringify(st.places));

    console.log('Live work trip');
    await page.goto(BASE + '#home'); await page.waitForSelector('[data-action="startTrip"]');
    await ui.act('startTrip', '[data-type="work"]'); await page.waitForSelector('[data-action="stopTrip"]'); await ui.settle();
    let t = st.trips[0];
    check('start: active row with start pin, vehicle and live mode', st.trips.length === 1 && t.status === 'active' && t.start_lat === -26.7145 && t.vehicle_id === st.vehicles[0].id && t.entry_mode === 'live', JSON.stringify(t));
    await ctx.setGeolocation({ latitude: -26.6900, longitude: 27.1100 });
    await ui.act('stopTrip'); await page.waitForSelector('#tripForm'); await ui.settle();
    t = st.trips[0];
    check('stop: both pins and measured km are on the server before the form is saved', t.status === 'active' && !!t.ended_at && t.end_lat === -26.69 && t.routed_km === 4.3 && t.km_source === 'osrm', JSON.stringify({ s: t.status, e: t.ended_at, r: t.routed_km }));
    check('stop: From is the named place and typed as home; To is reverse-geocoded', (await page.inputValue('#from_text')) === 'Home' && (await page.inputValue('#origin_type')) === 'home' && (await page.inputValue('#to_text')) === 'Wolmarans St, Potchefstroom Central, Potchefstroom', await page.inputValue('#to_text'));
    check('stop: out-of-date ward labels from the map data are kept out of the place name', !/ward\s*\d/i.test(await page.inputValue('#to_text')));
    await page.click('#tripForm button[type=submit]'); await ui.settle();
    check('save without a reason is refused in the app', /SARS needs the reason/.test(await ui.toast()) && st.trips[0].status === 'active', await ui.toast());
    await page.fill('#reason', 'Ward 10 site visit'); await page.click('#tripForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    t = st.trips[0];
    check('save: complete, distance 4.3, business 4.3, one row only', st.trips.length === 1 && t.status === 'complete' && t.distance_km === 4.3 && t.business_km === 4.3 && t.reason === 'Ward 10 site visit', JSON.stringify(t));
    check('Home shows today\'s work trip', /Work trips\s*1 · 4,3 km/.test(await ui.text()), await ui.text());

    console.log('Stop survives a reload');
    await ui.act('startTrip', '[data-type="work"]'); await page.waitForSelector('[data-action="stopTrip"]'); await ui.act('stopTrip'); await page.waitForSelector('#tripForm'); await ui.settle();
    await page.goto(BASE + '#home'); await page.reload(); await page.waitForSelector('[data-action="completeTrip"]', { timeout: 8000 });
    check('after reload Home offers to complete the stopped trip', /Stopped, not yet saved/.test(await ui.text()));
    await ui.act('completeTrip'); await page.waitForSelector('#tripForm');
    check('the stopped trip kept its end pin and distance', (await page.inputValue('#distance_km')) === '4.3' && /Wolmarans/.test(await page.inputValue('#to_text')));
    await page.fill('#reason', 'Council meeting'); await page.fill('#distance_km', '9'); await page.click('#tripForm button[type=submit]'); await ui.settle();
    check('changing the measured distance needs a reason', /why the distance differs/.test(await ui.toast()), await ui.toast());
    await page.fill('#opening_km', '120100'); await page.fill('#closing_km', '120109'); await ui.settle(150);
    check('odometer readings set the distance', (await page.inputValue('#distance_km')) === '9.0');
    await page.click('#tripForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    t = st.trips.find(x => x.reason === 'Council meeting');
    check('odometer-based trip saved with source = odometer', t && t.status === 'complete' && t.distance_km === 9 && t.km_source === 'odometer' && t.opening_km === 120100, JSON.stringify(t && { d: t.distance_km, s: t.km_source }));

    console.log('Offline: start, stop and save with no signal, then sync in order');
    await ui.offline(true);
    await ui.act('startTrip', '[data-type="work"]'); await page.waitForSelector('[data-action="stopTrip"]'); await ui.settle();
    check('offline start is held on the phone', (await ui.ls('dalog.outbox')).length === 1 && st.trips.length === 2 && /offline/.test(await page.textContent('#sync')), await page.textContent('#sync'));
    await ui.act('stopTrip'); await page.waitForSelector('#tripForm'); await ui.settle();
    check('offline stop falls back to a flagged estimate', /Estimate only/.test(await ui.text()));
    await page.fill('#to_text', 'Ikageng clinic'); await page.fill('#reason', 'Flooding inspection'); await page.click('#tripForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    check('offline save queues three ordered writes and Home is usable', (await ui.ls('dalog.outbox')).length === 3 && st.trips.length === 2, String((await ui.ls('dalog.outbox')).length));
    await ui.offline(false); await page.waitForFunction(() => JSON.parse(localStorage.getItem('dalog.outbox') || '[]').length === 0, null, { timeout: 8000 });
    t = st.trips.find(x => x.reason === 'Flooding inspection');
    check('back online: queue drains, one complete row, nothing refused', st.trips.length === 3 && t && t.status === 'complete' && t.to_text === 'Ikageng clinic' && ((await ui.ls('dalog.failed')) || []).length === 0, JSON.stringify(t && { s: t.status, to: t.to_text }));

    console.log('Write ordering: a later write must never overtake an earlier one that has not landed');
    // The server is briefly unavailable (503) for the task's first write while the phone is online, so that write waits in the queue.
    await page.goto(BASE + '#task-start'); await page.waitForSelector('#taskTitle'); await page.fill('#taskTitle', 'Ordering probe');
    const mark = mock.log.length;
    mock.state.failNext = { path: '/rest/v1/task_sessions', status: 503, json: { message: 'upstream unavailable' } };
    await ui.act('startTask'); await page.waitForSelector('#taskNotes'); await ui.settle(700);
    await ui.act('evNote'); await page.waitForSelector('#evVal'); await page.fill('#evVal', 'probe note'); await page.click('#evQuick button[type=submit]'); await page.waitForSelector('.ev'); await ui.settle();
    await ui.act('finishTask'); await page.waitForSelector('[data-action="startTrip"]', { timeout: 6000 }).catch(() => {}); await ui.settle(600);
    const probe = st.task_sessions.find(x => x.title === 'Ordering probe');
    const lg = mock.log.slice(mark).filter(l => l.path === '/rest/v1/task_sessions' && (l.method === 'POST' || l.method === 'PATCH'));
    const i503 = lg.findIndex(l => l.status === 503), iOk = lg.findIndex((l, i) => i > i503 && l.method === 'POST' && l.status === 201), iPatch = lg.findIndex(l => l.method === 'PATCH');
    check('a write held back by a server hiccup is sent before the writes that depend on it', i503 === 0 && iOk > i503 && iPatch > iOk && probe && probe.status === 'complete' && (await ui.ls('dalog.outbox')).length === 0 && ((await ui.ls('dalog.failed')) || []).length === 0,
      JSON.stringify({ sequence: lg.map(l => l.method + ' ' + l.status), status: probe && probe.status, toast: await ui.toast(), failed: await ui.ls('dalog.failed') }));
    st.task_sessions = st.task_sessions.filter(x => x.title !== 'Ordering probe'); st.evidence = st.evidence.filter(e => e.note !== 'probe note');
    await page.goto(BASE + '#home'); await page.reload(); await page.waitForSelector('[data-action="startTrip"]');

    console.log('Personal trip and hand-entered trip');
    await ui.act('startTrip', '[data-type="personal"]'); await page.waitForSelector('[data-action="stopTrip"]'); await ui.act('stopTrip'); await page.waitForSelector('#tripForm');
    check('personal trip form has no reason field', !(await page.isVisible('#reason')));
    await page.click('#tripForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    t = st.trips.find(x => x.trip_type === 'personal');
    check('personal trip keeps its distance and claims nothing', t && t.status === 'complete' && t.distance_km === 4.3 && t.business_km === 0, JSON.stringify(t && { d: t.distance_km, b: t.business_km }));
    await ui.act('manualTrip'); await page.waitForSelector('#trip_date');
    const yday = await page.evaluate(() => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    await page.fill('#trip_date', yday); await page.fill('#from_text', 'NWU'); await page.fill('#to_text', 'Ward 18 hall'); await page.fill('#reason', 'Ward committee'); await page.fill('#distance_km', '12.5'); await page.click('#tripForm button[type=submit]'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    t = st.trips.find(x => x.entry_mode === 'manual');
    check('hand-entered trip is saved, dated yesterday and marked manual', t && t.status === 'complete' && t.trip_date === yday && t.distance_km === 12.5 && t.km_source === 'manual', JSON.stringify(t && { d: t.trip_date, m: t.entry_mode }));
    await page.goto(BASE + '#log'); await ui.settle(500);
    check('Log lists it as entered by hand', /entered by hand/.test(await ui.text()));

    console.log('Tasks');
    await page.goto(BASE + '#task-start'); await page.waitForSelector('#taskTitle'); await page.fill('#taskTitle', 'Flooding inspection'); await page.fill('#taskWard', 'Ward 10');
    await ui.act('startTask'); await page.waitForSelector('#taskNotes'); await ui.settle(600);
    let k = st.task_sessions[0];
    check('task starts with place name', st.task_sessions.length === 1 && k.status === 'active' && k.ward === 'Ward 10' && /Wolmarans/.test(k.start_place || ''), JSON.stringify(k));
    await ui.act('finishTask'); await ui.settle();
    check('finishing without evidence is refused', /at least one piece of evidence/.test(await ui.toast()) && st.task_sessions[0].status === 'active');
    await page.fill('#taskNotes', 'Met residents at Mohadin St'); await page.fill('#taskOutcome', 'Logged ref 4471');
    await ui.act('evNote'); await page.waitForSelector('#evVal'); await page.fill('#evVal', 'Culvert blocked'); await page.click('#evQuick button[type=submit]'); await page.waitForSelector('.ev'); await ui.settle();
    check('typed notes survive the re-render after adding evidence', (await page.inputValue('#taskNotes')) === 'Met residents at Mohadin St' && st.evidence.length === 1 && st.evidence[0].task_session_id === k.id);
    await ui.act('finishTask'); await page.waitForSelector('[data-action="startTrip"]'); await ui.settle();
    k = st.task_sessions[0];
    check('task finished with notes and outcome', k.status === 'complete' && k.outcome === 'Logged ref 4471' && k.notes === 'Met residents at Mohadin St' && !!k.ended_at, JSON.stringify({ s: k.status, o: k.outcome }));
    await page.goto(BASE + '#task-manual'); await page.waitForSelector('#mNote'); await page.fill('#mTitle', 'MPAC sitting'); await page.fill('#mStart', '09:00'); await page.fill('#mEnd', '11:30'); await page.fill('#mNote', 'Item 4.2 deferred to January'); await page.click('#taskManualForm button[type=submit]'); await ui.settle(700);
    k = st.task_sessions.find(x => x.entry_mode === 'manual');
    check('hand-entered task: 2.5 h, complete, with its note as evidence', k && k.status === 'complete' && (new Date(k.ended_at) - new Date(k.started_at)) === 9000000 && st.evidence.some(e => e.task_session_id === k.id && e.note === 'Item 4.2 deferred to January' && e.lat == null), JSON.stringify(k));

    console.log('Expenses');
    await page.goto(BASE + '#home'); await page.waitForSelector('[data-action="newExpense"]'); await ui.act('newExpense'); await page.waitForSelector('#xAmt');
    await page.fill('#xAmt', '150'); await page.fill('#xDesc', 'Data bundle'); await page.dblclick('#expForm button[type=submit]'); await ui.settle(700);
    check('double tap on Save creates one expense', st.expenses.length === 1 && st.expenses[0].amount_rands === 150, String(st.expenses.length));
    await page.click('[data-action="openExpense"]'); await page.waitForSelector('#xAmt'); await page.fill('#xAmt', '175'); await page.click('#expForm button[type=submit]'); await ui.settle(500);
    check('editing changes the same expense', st.expenses.length === 1 && st.expenses[0].amount_rands === 175);
    await page.click('[data-action="openExpense"]'); await page.waitForSelector('#xAmt'); await page.goBack(); await ui.settle(300);
    await ui.act('newExpense'); await page.waitForSelector('#xAmt');
    check('Add expense opens a blank form after viewing an old one', (await page.inputValue('#xAmt')) === '' && (await page.inputValue('#xDesc')) === '');
    await page.fill('#xAmt', '20'); await page.fill('#xDesc', 'Stationery'); await page.click('#expForm button[type=submit]'); await ui.settle(500);
    check('new expense does not overwrite the old one', st.expenses.length === 2 && st.expenses.some(x => x.amount_rands === 175) && st.expenses.some(x => x.amount_rands === 20));

    console.log('Focus events do not wipe a form');
    await page.goto(BASE + '#home'); await page.waitForSelector('[data-action="manualTrip"]'); await ui.act('manualTrip'); await page.waitForSelector('#reason'); await page.fill('#reason', 'half typed');
    const before = mock.log.length;
    const events = await page.evaluate(async () => { const seen = []; const { data } = sb.auth.onAuthStateChange(ev => seen.push(ev)); await sb.auth.refreshSession(); await new Promise(r => setTimeout(r, 400)); data.subscription.unsubscribe(); return seen; });
    check('half-typed text survives the client re-announcing the session', events.includes('TOKEN_REFRESHED') && mock.log.slice(before).some(l => l.path === '/auth/v1/token') && (await page.inputValue('#reason').catch(() => null)) === 'half typed', JSON.stringify(events));

    console.log('Export');
    await page.goto(BASE + '#export'); await page.waitForSelector('[data-action="loadSummary"]'); await ui.act('loadSummary'); await page.waitForSelector('[data-action="exportLogbook"]');
    check('summary renders', /Business km claimed/.test(await ui.text()));
    let [dl] = await Promise.all([page.waitForEvent('download'), ui.act('exportLogbook')]);
    let wb = XLSX.read(fs.readFileSync(await dl.path()), { type: 'buffer' }); let rows = XLSX.utils.sheet_to_json(wb.Sheets.Logbook, { header: 1, defval: '' });
    const expectHead = ['Date', 'Opening Kilometres', 'Closing Kilometres', 'Total Business Kms', 'From', 'To', 'Reason', 'Actual Fuel & Oil Costs (R)', 'Actual Repairs & Maintenance Costs (R)'];
    const headIdx = rows.findIndex(r => r[0] === 'Date'); const body = rows.slice(headIdx + 1).filter(r => /^\d{4}-/.test(String(r[0])));
    const workDone = st.trips.filter(x => x.trip_type === 'work' && x.status === 'complete');
    check('logbook file: SARS column headings in SARS order', JSON.stringify(rows[headIdx]) === JSON.stringify(expectHead), JSON.stringify(rows[headIdx]));
    check('logbook file: opening odometer in the header block', rows.some(r => /Opening kilometres/.test(r[0]) && r[1] === 120000));
    check('logbook file: one row per completed work trip, km add up', body.length === workDone.length && Math.abs(body.reduce((s, r) => s + Number(r[3]), 0) - workDone.reduce((s, x) => s + x.business_km, 0)) < 1e-9, body.length + ' vs ' + workDone.length);
    check('logbook file: every row has date, km, from, to and reason', body.every(r => r[0] && r[3] !== '' && r[4] && r[5] && r[6]));
    check('logbook file: detail sheet records how each trip was entered', XLSX.utils.sheet_to_json(wb.Sheets['Trip detail']).some(r => r.how_entered === 'manual') && dl.suggestedFilename() === 'SARS_Logbook_2026-27_Polo.xlsx', dl.suggestedFilename());
    await ui.act('buildMonth'); await page.waitForSelector('#powText');
    const pow = await page.textContent('#powText');
    check('month summary lists tasks, wards and travel', /Activity report/.test(pow) && /Tasks:\* 2 sessions/.test(pow) && /Ward 10 ×1/.test(pow) && new RegExp('Travel:\\* ' + workDone.length + ' work trips').test(pow), pow.replace(/\n/g, ' | '));
    [dl] = await Promise.all([page.waitForEvent('download'), ui.act('exportWork')]);
    wb = XLSX.read(fs.readFileSync(await dl.path()), { type: 'buffer' });
    check('proof-of-work file has Tasks, Evidence, Trips, Expenses', ['Tasks', 'Evidence', 'Trips', 'Expenses'].every(n => wb.SheetNames.includes(n)) && XLSX.utils.sheet_to_json(wb.Sheets.Tasks).length === 2 && XLSX.utils.sheet_to_json(wb.Sheets.Expenses).length === 2, wb.SheetNames.join(','));

    console.log('Sign out');
    await page.goto(BASE + '#settings'); await page.waitForSelector('[data-action="signOut"]'); await ui.act('signOut'); await page.waitForSelector('#authEmail');
    check('sign-out returns to the sign-in screen and clears the phone copy', (await ui.ls('dalog.logcache')) === null && (await ui.ls('dalog.activeTrip')) === null);

    check('no script errors or blocked resources during the whole run', errors.length === 0, errors.join(' | '));
    check('no requests to any host other than the app, Supabase, OSRM and Nominatim', stray.length === 0, stray.join(', '));
    await ctx.close();
  }

  // =================================================================== account flows
  {
    console.log('\nCreate account: confirm by email, then signed in without another tap');
    const { mock, ctx, page, errors, ui } = await session({ mockOpts: { ownerClaimed: false, confirmEmail: true } });
    await page.goto(BASE); await page.waitForSelector('#authForm[data-kind="create"]', { timeout: 6000 });
    check('with no owner yet the app opens on Create the owner account', (await page.textContent('#authForm h3')) === 'Create the owner account');
    await page.fill('#authEmail', 'New.Owner@Example.com'); await page.fill('#authPass', 'short'); await page.click('#authForm button[type=submit]'); await ui.settle(300);
    check('a short password is refused before anything is sent', /at least 8 characters/.test(await page.textContent('#authMsg')) && mock.state.signups.length === 0);
    await page.fill('#authPass', 'correct-horse'); await page.click('#authForm button[type=submit]'); await page.waitForSelector('[data-auth="continue"]');
    check('after sign-up: a Confirm your email screen naming the address', /Confirm your email/.test(await ui.text()) && /new\.owner@example\.com/.test(await ui.text()) && mock.state.signups[0] === 'new.owner@example.com', await ui.text());
    await page.click('[data-auth="continue"]'); await ui.settle(500);
    check('continuing before tapping the link explains what is missing', /Not confirmed yet/.test(await page.textContent('#authMsg')) && (await page.isVisible('[data-auth="continue"]')), await page.textContent('#authMsg'));
    await page.click('[data-auth="resend"]'); await ui.settle(200);
    check('asking for the email again too soon gives the wait in seconds', /Wait \d+ seconds/.test(await page.textContent('#authMsg')) && mock.state.resends === 0, await page.textContent('#authMsg'));
    await page.evaluate(() => { AUTH.resendAt = 0; }); await page.click('[data-auth="resend"]'); await ui.settle(400);
    check('the email can be sent again once the wait is over', mock.state.resends === 1 && /Sent again/.test(await page.textContent('#authMsg')));
    await page.evaluate(() => { AUTH.resendAt = 0; }); mock.state.failNext = { path: '/auth/v1/resend', status: 429, json: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } };
    await page.click('[data-auth="resend"]'); await ui.settle(400);
    check('the mail service\'s hourly limit is explained in plain words', /only a few an hour/.test(await page.textContent('#authMsg')), await page.textContent('#authMsg'));
    mock.state.confirmed = true;                                                   // the link is tapped (in the mail app, another tab, another device)
    await page.waitForTimeout(4200); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('[data-action="startTrip"]', { timeout: 6000 });
    check('returning to the app after confirming signs in by itself', (await ui.text()).includes('Start work trip'));
    await page.waitForFunction(() => /Finish setting up/.test(document.querySelector('#main').textContent), null, { timeout: 6000 }).catch(() => {});   // drawn once the first data load finishes
    check('Home starts with a setup checklist', /Finish setting up · 0 of 3 done/.test(await ui.text()), (await ui.text()).slice(0, 120));
    const stored = await page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join('\n'));
    check('the password is never written to the phone; the email is remembered', !stored.includes('correct-horse') && (await ui.ls('dalog.email')) === 'test@example.com');
    check('no script errors in the create-account flow', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  {
    console.log('Sign-up edge cases');
    let s = await session({ mockOpts: { ownerClaimed: null, signupLocked: true } });
    await s.page.goto(BASE); await s.page.waitForSelector('#authEmail'); await s.ui.settle(600);
    check('when the app cannot tell, a plain Create account button is shown', (await s.page.textContent('[data-mode="create"]')) === 'Create account');
    await s.page.click('[data-mode="create"]'); await s.page.fill('#authEmail', 'late@example.com'); await s.page.fill('#authPass', 'correct-horse'); await s.page.click('#authForm button[type=submit]'); await s.ui.settle(500);
    check('a sign-up the server refuses says sign-ups are closed', /new sign-ups are closed/.test(await s.page.textContent('#authMsg')), await s.page.textContent('#authMsg'));
    await s.ctx.close();
    s = await session({ mockOpts: { ownerClaimed: false, confirmEmail: true, existingEmails: ['test@example.com'] } });
    await s.page.goto(BASE); await s.page.waitForSelector('#authForm[data-kind="create"]'); await s.page.fill('#authEmail', 'test@example.com'); await s.page.fill('#authPass', 'correct-horse'); await s.page.click('#authForm button[type=submit]'); await s.ui.settle(500);
    check('signing up with an address that already has an account leads to Sign in', (await s.page.textContent('#authForm h3')) === 'Sign in' && /already has an account/.test(await s.page.textContent('#authMsg')) && (await s.page.inputValue('#authEmail')) === 'test@example.com');
    await s.ctx.close();
  }
  {
    console.log('Email links that open the app');
    let s = await session({ mockOpts: { ownerClaimed: true } }); let tok = s.mock.session();
    await s.page.goto(BASE + `#access_token=${tok.access_token}&expires_in=3600&refresh_token=${tok.refresh_token}&token_type=bearer&type=signup`);
    await s.page.waitForSelector('[data-action="startTrip"]', { timeout: 8000 }); await s.ui.settle(300);
    check('a confirmation link that lands on the app signs in directly', (await s.ui.text()).includes('Start work trip') && !/access_token/.test(s.page.url()), s.page.url());
    await s.ctx.close();

    s = await session({ mockOpts: { ownerClaimed: true } }); tok = s.mock.session();
    await s.page.goto(BASE + `#access_token=${tok.access_token}&expires_in=3600&refresh_token=${tok.refresh_token}&token_type=bearer&type=recovery`);
    await s.page.waitForSelector('#newPassForm', { timeout: 8000 });
    check('a reset link opens on Choose a new password, with the app hidden behind it', (await s.page.textContent('#newPassForm h3')) === 'Choose a new password' && !(await s.page.isVisible('#nav')));
    await s.page.fill('#newPass1', 'short'); await s.page.click('#newPassForm button[type=submit]'); await s.ui.settle(300);
    check('the new password must be 8 or more characters', /at least 8 characters/.test(await s.page.textContent('#authMsg')) && s.mock.state.passwordSet === null);
    await s.page.fill('#newPass1', 'brand-new-secret'); await s.page.click('#newPassForm button[type=submit]'); await s.page.waitForSelector('[data-action="startTrip"]', { timeout: 6000 });
    check('saving it goes straight to Home, signed in', s.mock.state.passwordSet === 'brand-new-secret' && (await s.page.isVisible('#nav')));
    await s.ctx.close();

    s = await session({ mockOpts: { ownerClaimed: true } });
    await s.page.goto(BASE + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'); await s.page.waitForSelector('#authEmail'); await s.ui.settle(500);
    check('an expired or used link shows a clear message on the sign-in screen', /expired or was already used/.test(await s.page.textContent('#authMsg')) && (await s.page.textContent('#authForm h3')) === 'Sign in', await s.page.textContent('#authMsg'));
    check('the error is removed from the address', !/error/.test(s.page.url()), s.page.url());
    console.log('Forgot password');
    await s.page.click('[data-mode="forgot"]'); await s.page.waitForSelector('#forgotForm'); await s.page.fill('#authEmail', 'test@example.com'); await s.page.click('#forgotForm button[type=submit]'); await s.ui.settle(500);
    check('Forgot password sends one request and shows Check your email', s.mock.state.recoveries.length === 1 && /Check your email/.test(await s.ui.text()) && /test@example\.com/.test(await s.ui.text()));
    await s.page.click('[data-mode="signin"]'); await s.page.waitForSelector('#authForm');
    check('back on Sign in the email is still filled in', (await s.page.inputValue('#authEmail')) === 'test@example.com');
    check('no script errors in the link and reset flows', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
  }

  // =================================================================== server refusal is surfaced, not swallowed
  {
    console.log('\nServer refusal');
    const { mock, ctx, page, ui } = await session(); await ui.signIn();
    await ui.act('newExpense'); await page.waitForSelector('#xAmt'); await page.fill('#xAmt', '50'); await page.fill('#xDesc', 'Test');
    mock.state.failNext = { path: '/rest/v1/expenses', status: 403, json: { code: '42501', message: 'new row violates row-level security policy for table "expenses"' } };
    await page.click('#expForm button[type=submit]'); await ui.settle(600);
    check('a write the server refuses shows its reason and stays on the form', /row-level security/.test(await ui.toast()) && (await page.isVisible('#expForm')) && mock.store.expenses.length === 0, await ui.toast());
    await ctx.close();
  }

  // =================================================================== service worker: opens with no signal
  {
    console.log('\nOffline start-up');
    const { ctx, page, ui } = await session({ sw: 'allow' }); await ui.signIn();
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }, null, { timeout: 10000 });
    await page.waitForFunction(async () => { const k = await caches.keys(); if (!k.length) return false; const c = await caches.open(k[0]); return (await c.keys()).length >= 8; }, null, { timeout: 10000 });
    await ui.offline(true); await page.reload(); await page.waitForSelector('[data-action="startTrip"]', { timeout: 8000 });
    check('with no signal the app still opens to Home from the phone', (await ui.text()).includes('Start work trip') && /offline/.test(await page.textContent('#sync')));
    await ctx.close();
  }

  // =================================================================== dark theme screenshot for a visual check
  {
    const { ctx, page, ui } = await session({ scheme: 'dark' }); await ui.signIn(); await ui.act('startTrip', '[data-type="work"]'); await page.waitForSelector('[data-action="stopTrip"]');
    await page.screenshot({ path: path.resolve(__dirname, 'shot-dark-home.png') });
    await page.goto(BASE + '#task-start'); await page.waitForSelector('#taskTitle'); await page.screenshot({ path: path.resolve(__dirname, 'shot-dark-task.png') });
    await ctx.close();
  }
  {
    const { ctx, page, ui } = await session(); await ui.signIn(); await page.screenshot({ path: path.resolve(__dirname, 'shot-light-home.png') });
    await ui.act('manualTrip'); await page.waitForSelector('#trip_date'); await page.screenshot({ path: path.resolve(__dirname, 'shot-light-manual.png'), fullPage: true });
    await ctx.close();
  }

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed` + (failed.length ? '\nFAILED:\n' + failed.map(f => ' - ' + f.name + (f.detail ? '  -> ' + f.detail : '')).join('\n') : ''));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(2); });
