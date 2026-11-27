// In-memory mock of the Supabase HTTP API (GoTrue + PostgREST + Storage) for Playwright route interception.
// The app runs the REAL supabase-js client against this, so auth-lock, header and query-shape bugs surface.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// confirmEmail: sign-up returns no session until state.confirmed is set (as when the emailed link is tapped).
// ownerClaimed: true / false, or null for "the app cannot tell" (no row). existingEmails: addresses that already have an account.
function createMock({ confirmEmail = false, ownerClaimed = true, existingEmails = [], signupLocked = false } = {}) {
  const user = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'test@example.com', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
  const store = {
    vehicles: [], tax_years: [], places: [], trips: [], task_sessions: [], evidence: [], expenses: [],
    task_categories: [
      { id: 'c1000000-0000-4000-8000-000000000001', user_id: user.id, name: 'Council / committee meeting', sort_order: 1, active: true },
      { id: 'c1000000-0000-4000-8000-000000000002', user_id: user.id, name: 'Ward visit / site inspection', sort_order: 2, active: true },
    ],
    tax_year_params: [
      { year_label: '2026/27', starts_on: '2026-03-01', ends_on: '2027-02-28', prescribed_rate_c_per_km: 495, source: 'test' },
      { year_label: '2025/26', starts_on: '2025-03-01', ends_on: '2026-02-28', prescribed_rate_c_per_km: 476, source: 'test' },
    ],
    app_status: ownerClaimed === null ? [] : [{ id: true, owner_claimed: ownerClaimed }],
  };
  const log = [];            // every request: {method, path, query, body, status}
  const state = { offline: false, failNext: null, uploads: [], confirmed: true, signupLocked, signups: [], resends: 0, recoveries: [], passwordSet: null };

  const session = () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access_token = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: user.id, role: 'authenticated', email: user.email, exp, aud: 'authenticated' }) + '.sig';
    return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'refresh-1', user };
  };

  const view = (name) => {
    if (name !== 'v_sars_logbook') return store[name];
    return store.trips.filter(t => t.trip_type === 'work' && t.status === 'complete').map(t => ({
      id: t.id, user_id: t.user_id, vehicle_id: t.vehicle_id ?? null, Date: t.trip_date, 'Opening Kilometres': t.opening_km ?? null, 'Closing Kilometres': t.closing_km ?? null,
      'Total Business Kms': t.business_km ?? null, From: t.from_text ?? null, To: t.to_text ?? null, Reason: t.reason ?? null,
      'Actual Fuel & Oil Costs (R)': t.fuel_oil_rands ?? null, 'Actual Repairs & Maintenance Costs (R)': t.repairs_maintenance_rands ?? null,
      stream: t.stream, origin_type: t.origin_type ?? null, destination_type: t.destination_type ?? null,
      is_home_office_commute: (t.origin_type === 'home' && t.destination_type === 'municipal_offices') || (t.origin_type === 'municipal_offices' && t.destination_type === 'home'),
      km_source: t.km_source ?? null, routed_km: t.routed_km ?? null, started_at: t.started_at, ended_at: t.ended_at ?? null, created_at: t.created_at,
      distance_km: t.distance_km ?? null, entry_mode: t.entry_mode ?? null,
    }));
  };
  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
  const match = (row, params) => {
    for (const [k, raw] of params) {
      if (RESERVED.has(k)) continue;
      const i = raw.indexOf('.'); const op = raw.slice(0, i); const val = raw.slice(i + 1); const v = row[k];
      const s = v === null || v === undefined ? null : String(v);
      if (op === 'eq') { if (s !== val) return false; }
      else if (op === 'neq') { if (s === val) return false; }
      else if (op === 'gte') { if (s === null || !(s >= val)) return false; }
      else if (op === 'lte') { if (s === null || !(s <= val)) return false; }
      else if (op === 'is') { if (val === 'null' ? s !== null : s !== val) return false; }
      else throw new Error('mock: unsupported filter ' + k + '=' + raw);
    }
    return true;
  };
  const dbError = (status, code, message) => ({ status, json: { code, message, details: null, hint: null } });

  // server-side rules the app relies on (mirrors the Postgres triggers and the trips_sars_minimum check)
  function applyTripRules(t) {
    if (t.status === 'complete') {
      if (t.distance_km == null) { if (t.opening_km != null && t.closing_km != null) t.distance_km = t.closing_km - t.opening_km; else if (t.routed_km != null) t.distance_km = t.routed_km; }
      t.business_km = t.trip_type === 'work' ? (t.distance_km ?? null) : 0;
      if (!t.ended_at) t.ended_at = new Date().toISOString();
    }
  }
  function sarsMinimum(t) {
    const derived = t.distance_km ?? ((t.opening_km != null && t.closing_km != null) ? t.closing_km - t.opening_km : t.routed_km);
    const blank = v => v == null || String(v).trim() === '';
    if (t.status === 'complete' && t.trip_type === 'work' && (derived == null || blank(t.from_text) || blank(t.to_text) || blank(t.reason)))
      return { code: '23514', message: 'new row for relation "trips" violates check constraint "trips_sars_minimum"', details: null, hint: null };
    return null;
  }

  async function handle(route) {
    const req = route.request(); const url = new URL(req.url()); const method = req.method(); const path = url.pathname;
    let body = null; try { body = req.postDataJSON(); } catch (e) { body = req.postData(); }
    const rec = { method, path, query: url.search, body, status: 0 }; log.push(rec);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
    const send = (status, json, headers = {}) => { rec.status = status; return route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...headers }, body: json === undefined ? '' : JSON.stringify(json) }); };
    if (method === 'OPTIONS') return send(204);
    if (state.offline) { rec.status = -1; return route.abort('internetdisconnected'); }
    if (state.failNext && path.includes(state.failNext.path)) { const f = state.failNext; state.failNext = null; return send(f.status, f.json); }

    // ---- auth ----
    if (path === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'password') {
        if (body.password === 'wrong-password') return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (!state.confirmed) return send(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        return send(200, session());
      }
      return send(200, session());
    }
    if (path === '/auth/v1/signup') {
      state.signups.push(body.email);
      if (state.signupLocked) return send(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error saving new user' });
      // an address that already has an account gets a look-alike reply with no identities (the real service does this to avoid revealing accounts)
      if (existingEmails.includes(body.email)) return send(200, { ...user, id: '99999999-9999-4999-8999-999999999999', email: body.email, identities: [], confirmation_sent_at: new Date().toISOString() });
      if (!confirmEmail) { state.confirmed = true; return send(200, session()); }
      state.confirmed = false;
      return send(200, { ...user, email: body.email, identities: [{ identity_id: 'i1', provider: 'email' }], confirmation_sent_at: new Date().toISOString() });
    }
    if (path === '/auth/v1/resend') { state.resends++; return send(200, {}); }
    if (path === '/auth/v1/user') { if (method === 'PUT') { state.passwordSet = body.password; return send(200, user); } return send(200, user); }
    if (path === '/auth/v1/logout') return send(204);
    if (path === '/auth/v1/recover') { state.recoveries.push(body.email); return send(200, {}); }

    // ---- storage ----
    if (path.startsWith('/storage/v1/object/sign/')) return send(200, { signedURL: '/object/sign/evidence/x?token=t' });
    if (path.startsWith('/storage/v1/object/')) { state.uploads.push(path.replace('/storage/v1/object/', '')); return send(200, { Key: path.replace('/storage/v1/object/', ''), Id: 'obj1' }); }

    // ---- rpc ----
    if (path === '/rest/v1/rpc/sars_summary') {
      const ty = store.tax_years.find(t => t.id === body.p_tax_year_id); if (!ty) return send(200, null);
      const rows = view('v_sars_logbook').filter(r => r.vehicle_id === ty.vehicle_id && r.stream === '3701');
      const all = rows.reduce((s, r) => s + Number(r['Total Business Kms'] || 0), 0); const commute = rows.filter(r => r.is_home_office_commute).reduce((s, r) => s + Number(r['Total Business Kms'] || 0), 0);
      const total = ty.opening_km != null && ty.closing_km != null ? ty.closing_km - ty.opening_km : null;
      return send(200, { year_label: ty.year_label, period: { from: '2026-03-01', to: '2027-02-28' }, vehicle: {}, odometer: { opening: ty.opening_km, closing: ty.closing_km, total_km: total }, trips: rows.length,
        business_km: { all, home_office_commute: commute, claimed: all - commute, commute_excluded: true }, band: { max_value: 300000 }, per_km: { total: total ? 6.81 : null }, computed_deduction: total ? 6.81 * (all - commute) : null,
        allowable_deduction: total ? 6.81 * (all - commute) : null, travel_allowance_3701: ty.travel_allowance_rands, public_office_3708: { allowance: ty.public_office_allowance_rands, expenses_total: 0, expenses_by_category: {} }, unassigned_work_trips: store.trips.filter(t => t.trip_type === 'work' && t.status === 'complete' && !t.vehicle_id).length, rates_source: 'mock' });
    }

    // ---- rest tables ----
    const m = path.match(/^\/rest\/v1\/([a-z_]+)$/); if (!m) return send(404, { message: 'mock: no route ' + path });
    const table = m[1]; const params = [...url.searchParams.entries()]; const prefer = req.headers()['prefer'] || '';
    if (!(table in store) && table !== 'v_sars_logbook') return send(404, { code: '42P01', message: 'relation "' + table + '" does not exist' });
    try {
      if (method === 'GET' || method === 'HEAD') {
        let rows = view(table).filter(r => match(r, params));
        const order = url.searchParams.get('order'); if (order) { const [col, dir] = order.split('.'); rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
        const limit = url.searchParams.get('limit'); if (limit) rows = rows.slice(0, Number(limit));
        return send(200, rows);
      }
      if (method === 'POST') {
        const arr = Array.isArray(body) ? body : [body];
        const conflictCols = (url.searchParams.get('on_conflict') || 'id').split(',');
        for (const r of arr) {
          const existing = store[table].find(x => conflictCols.every(c => x[c] === r[c]));
          if (existing) {
            if (!prefer.includes('merge-duplicates')) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
            const { id: _ignore, ...rest } = r; Object.assign(existing, conflictCols.includes('id') ? r : rest);
            if (table === 'trips') { const bad = sarsMinimum(existing); if (bad) return send(400, bad); applyTripRules(existing); }
            continue;
          }
          const row = { user_id: user.id, created_at: new Date().toISOString(), ...r };
          if (table === 'trips') { if (row.stream === undefined) row.stream = '3701'; if (row.entry_mode === undefined) row.entry_mode = 'live'; const bad = sarsMinimum(row); if (bad) return send(400, bad); applyTripRules(row); }
          if (table === 'evidence' && row.storage_path == null && row.note == null && row.reference == null && row.odometer_km == null) return send(400, { code: '23514', message: 'new row violates check constraint' });
          store[table].push(row);
        }
        return prefer.includes('return=representation') ? send(201, arr) : send(201);
      }
      if (method === 'PATCH') {
        const rows = store[table].filter(r => match(r, params));
        for (const r of rows) {
          if (table === 'task_sessions' && body.status === 'complete' && r.status !== 'complete' && !store.evidence.some(e => e.task_session_id === r.id)) return send(400, { code: '23514', message: 'Task session ' + r.id + ' cannot be completed without evidence' });
          if (table === 'trips') { const bad = sarsMinimum({ ...r, ...body }); if (bad) return send(400, bad); }
          Object.assign(r, body); if (table === 'trips') applyTripRules(r);
        }
        const headers = prefer.includes('count=exact') ? { 'content-range': (rows.length ? '0-' + (rows.length - 1) : '*') + '/' + rows.length } : {};
        return prefer.includes('return=representation') ? send(200, rows, headers) : send(204, undefined, headers);
      }
      if (method === 'DELETE') { const before = store[table].length; store[table] = store[table].filter(r => !match(r, params)); return prefer.includes('return=representation') ? send(200, new Array(before - store[table].length).fill({})) : send(204); }
    } catch (e) { return send(400, { code: 'MOCK', message: e.message }); }
    return send(405, { message: 'mock: method' });
  }
  return { handle, store, log, state, user, session };
}
module.exports = { createMock };
