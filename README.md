# DA Logbook — setup and handover

Version 0.3.1 · 27 Nov 2026

**App address: https://zanmander.github.io/da-logbook/**

Mobile web app for a DA councillor: SARS-shaped travel logbook (IRP5 3701 travel allowance), section 8(1)(d) expenses (3708 public office allowance), timed DA task sessions that close only with evidence, and exports for SARS and for performance review.

## Status

| Part | State |
|---|---|
| Database (Supabase project `da-logbook`, ref `nnwiuooawsyfspkqerhv`, org Hydranex, London, free tier) | Live. Migrations 001–008 applied. Security advisor: no findings on the database; one advisory on sign-in settings (leaked-password protection is off, a dashboard option). |
| App code (`docs/`) | Complete. 77 automated checks pass (see Testing). **Not yet used on a real phone.** |
| Hosting | **Live** on GitHub Pages from the `docs/` folder of the public repo `ZanMander/da-logbook`. A push to `main` redeploys in about a minute, and the app picks the new version up the next time it is opened with signal. |
| Owner account | Created and confirmed on 27 Nov 2026. New sign-ups are closed. |
| Email links | **One setting outstanding.** Until the Site URL in the Supabase dashboard points at the app, links in Supabase emails (confirm, reset password) do their job and then forward to `localhost:3000`, an error page. See "Account screens". |

Checked in a real browser on 27 Nov 2026 at the live address: served as `text/html`, sign-in screen renders, no console errors, the database answers from that address, the routing and place-name services answer, the spreadsheet module loads, and the offline copy is stored. Checked from a desktop browser at phone width — not from a phone.

### Correction to the first handover note

The first note gave `https://nnwiuooawsyfspkqerhv.supabase.co/functions/v1/app/` as a working app address. It never worked: Supabase delivers HTML from Edge Functions as `text/plain` unless the project has a paid custom domain, so a browser showed the page source. The deployed files were checked byte for byte; how a browser would render them was not. That address now forwards to the app address above.

## First run

1. Open the address on the phone (Safari on iPhone, Chrome on Android) → Share → **Add to Home Screen**. Use it from the icon.
2. **Sign in** with the owner's email and password. A phone's home-screen app keeps its own sign-in, separate from the browser, so sign in once there; it then stays signed in.
3. **Settings → Vehicle**: name, registration, value when acquired, maintenance-plan and fuel flags.
4. **Settings → Tax year**: opening odometer, the date and proof of that reading, the 3701 and 3708 amounts, months of business use.
5. **Settings → Named places**: stand at home, NWU and the municipal offices and tap each button. This is how a commute is told apart from a business trip.
6. Allow location when asked.

Home shows a three-item setup checklist until steps 3 to 5 are done.

## Account screens

- **Sign in.** Email (remembered on the device) and password, with Show/Hide. Wrong details get one plain sentence. Once an owner exists, creating an account is no longer offered.
- **Create the owner account.** Offered only while no account exists. After sign-up the app shows **Confirm your email** with the address, a button to continue, and a button to send the email again (one per minute; the built-in mail service also caps the project at a few emails an hour, which the app explains if it is hit). When you return to the app after tapping the link, it signs in by itself. The password typed at sign-up is held in memory for that purpose and never stored.
- **Forgot password.** Sends a reset link. Opening it shows **Choose a new password**, then goes to Home.
- **Links that open the app.** A confirmation link signs you in directly. An expired or already-used link shows a clear message on the sign-in screen and is removed from the address.

### The one setting these depend on

Supabase decides where its email links end up. The project still has the default (`http://localhost:3000`), so a link confirms the account or authorises the reset and then forwards to an error page. In the Supabase dashboard, under Authentication → URL Configuration:

- **Site URL:** `https://zanmander.github.io/da-logbook/`
- **Redirect URLs:** add `https://zanmander.github.io/da-logbook/**`

Until then: confirming an account still works (tap the link, ignore the error page, return to the app), but **a password reset cannot be completed**. The password can always be changed while signed in, under Settings → Account.

## What it does

- **Trips.** Start pins the position; Stop pins the end, measures the road distance between the pins and names both places. Both pins are saved the moment Stop is tapped, before the form is filled in. Distance can be corrected (a reason is required) or replaced by odometer readings. A forgotten trip can be added by hand; it is marked as hand-entered everywhere, with the time it was captured.
- **Tasks.** Category, title, ward, timer. Finishing needs at least one evidence item (photo, note or reference number). A past task can be logged by hand with its note as evidence.
- **Expenses.** The five section 8(1)(d) categories, receipt photo, optional link to a task.
- **Evidence.** Photos, notes, reference numbers, odometer readings, receipts; time-stamped, location-tagged when captured live.
- **Exports.** SARS logbook workbook (sheet 1 is the eLogbook layout with the opening/closing header; further sheets give GPS detail, trips left out and why, and the estimate). Proof-of-work workbook per month. WhatsApp-ready month summary.
- **Running tax estimate.** During the year the summary uses the latest odometer reading and pro-rates the fixed cost to today; it is labelled as an estimate.
- **No signal.** The app opens from the phone, and trips, tasks and notes are queued and sent in order when the connection returns. Photos need a connection at the time.

## Rules the database enforces (the app cannot bypass them)

- A completed work trip must have distance, from, to and reason — the SARS minimum.
- Business km = distance for work trips, 0 for personal trips (which still keep their distance for odometer reconciliation).
- A task cannot be completed without evidence.
- One trip cannot be claimed both by km under 3701 and at actual cost under 3708.
- Every insert, update and delete on trips, tasks, evidence, expenses, tax years and vehicles is copied to `audit_log` with a server timestamp; the app can read it and cannot change it.
- Row-level security: each account sees only its own rows and its own folder in the private `evidence` bucket (photos, PDFs and audio only, 15 MB each).
- Sign-ups after the first account are refused unless the address is in `private.signup_allowlist`.
- The cost calculation needs the vehicle value and an opening reading; without them it shows no figure rather than a wrong one.

## Testing

`npm install && npm test` runs `test/e2e.js`: the real app and the real Supabase client library in headless Chromium, served over http, against an in-memory copy of the Supabase API (`test/mock-supabase.js`). It walks sign-in, settings, live trips, a reload between Stop and Save, a full offline trip, write ordering after a server error, personal and hand-entered trips, tasks, expenses, both spreadsheet exports (opened and checked cell by cell), sign-out, a refused write, start-up with no signal, and that no request leaves for an unexpected host.

Three known bugs were re-introduced on purpose to confirm the tests catch them; all three are caught.

Database rules are tested separately, inside transactions that roll themselves back, against the live project.

**Not covered by any test:** real GPS hardware, the iPhone home-screen install, the camera, the iPhone share sheet for files, and the public routing and place-name services (`router.project-osrm.org`, `nominatim.openstreetmap.org`) from a South African mobile network.

## Review of version 0.1 → 0.2

| # | Problem in 0.1 | Fix |
|---|---|---|
| 1 | Hosting address showed source code, not the app | Rebuilt as a plain static site; needs a static host |
| 2 | A write could overtake an earlier one still waiting to send; the later one then failed with "record not found" | Every write goes through one ordered queue |
| 3 | "Add expense" after viewing an old expense overwrote the old one | Fixed, with a test |
| 4 | Returning to the app or an hourly token refresh could redraw the screen and wipe a half-filled form | Screen is redrawn only when the signed-in account changes |
| 5 | End pin lived only in memory until the form was saved; closing the app lost it | Saved at Stop |
| 6 | Personal trips stored 0 km, losing their distance | Separate distance column |
| 7 | A work trip could be completed with no distance or reason | Refused by the app and by the database |
| 8 | No way to add a forgotten trip or task | Hand entry, marked as such |
| 9 | Anyone with the address could register and store files | Sign-ups close after the first account; bucket limited to photos, PDFs, audio |
| 10 | Vehicle with no value was costed in the top band | No figure until the value is entered |
| 11 | No tax figure until the year closed | Running estimate from the latest odometer reading |
| 12 | GPS wait of up to 29 s with no way out; first coarse fix accepted | 15 s cap, "Continue without GPS", keeps the most accurate fix |
| 13 | Month boundaries used UTC, two hours out | Local time |
| 14 | Double tap on Save could create two records | One handler at a time |
| 15 | Two libraries and fonts loaded from third-party CDNs at run time | Libraries shipped with the app; system fonts; a content-security policy allows scripts only from the app itself |
| 16 | Green buttons unreadable in dark mode (white on light green) | Separate text colour |
| 17 | Ten foreign keys without indexes | Indexed |

One further suspected problem — sign-in hanging because of the client library's auth lock — was tested with the real library and did not occur.

## Known limits

- Two pins, no breadcrumb trail: detours are understated unless odometer readings are entered.
- One vehicle per account in the screens (the database allows more).
- Routing and place names come from free community services with no guarantee; when they fail the distance is a flagged estimate and names can be typed.
- The 2026/27 cost table is a copy of 2025/26 until SARS publishes its 2026-27 eLogbook; the Export screen says so.
- The free Supabase tier pauses a project after seven days without use; nothing is lost and it is restored from the dashboard.
- The year-end figure is an estimate for planning. Whether home → council chambers is private travel, and how the 3708 allowance is treated on assessment, are questions for a tax practitioner.

## Layout

```
docs/                   the site (GitHub Pages serves this folder): index.html, app.js, sw.js, manifest, icons, vendor/ (supabase-js 2.115.0, SheetJS 0.18.5 mini)
test/                   e2e.js, mock-supabase.js
supabase/functions/app/ index.ts — forwards the old address once NEW_URL is set
```

Database migrations live in the project itself (`supabase_migrations.schema_migrations`); `supabase db pull` writes them to disk.

## Parked

Background GPS trail (needs a native app), calendar sync, WhatsApp message counts, Gmail tagging, automatic weekly summary, several vehicles, several councillors with a constituency roll-up.
