# Field Force module

Built from the *Field Force Activation & Monitoring* plan (Collection FOS on CLU, Sales
RO / SRO / ABM-RO on Synoriq). It is kept separate from the rest of the HRMS on purpose:
other features never read its tables or call its code, so it can be switched off or
removed without affecting them.

## Switching it off

Set `FIELD_FORCE=off` on the server (Render → Environment). Its routes, morning clock,
portal menu and app card all disappear. Its tables stay in the database, untouched and unused.
Within the module, each company also has its own on/off switch (Field Force → Activation →
Morning messages), which is off until HR turns it on.

## What belongs to it

| Part | Where |
| --- | --- |
| Server code | `server/field-force/` (this folder): `index.js` is the only entry point; `activation.js` (Phase 1), `channels.js` (Phase 2), `tracking.js` (Phase 3) |
| Database | `server/migrations/067_field_force.sql`, `068_field_force_escalation.sql`, `069_field_force_tracking.sql`: tables `ff_staff`, `ff_settings`, `ff_days`, `ff_reports`, `ff_contacts`, `ff_consents`, `ff_pings`, `ff_visits`, `ff_alerts` (no columns on shared tables) |
| API | everything under `/api/field-force/` |
| Portal | `public/field-force.js`, the **Field Force** menu group |
| Phone app | `mobile/src/screens/FieldForce.tsx` (Home card), `mobile/src/fieldForceTask.ts` (background location) |
| Tests | `test/field-force-*.test.js` |

## Where it plugs into the rest (the only shared lines)

1. `server/index.js`: the import of `./field-force/index.js`, `registerFieldForce` in the
   route list, `scheduleFieldForce(app)` at start-up, and `/field-force.js` in `STATIC`.
2. `public/index.html`: the `<script src="/field-force.js">` tag.
3. `public/app.js`: the **Field Force** menu group (shown only when `config.features.field_force`),
   its icon, and the `fieldforce` page line.
4. `mobile/src/screens/More.tsx`: `<FieldForceCard … />` on the Home screen; `mobile/index.js`: the
   import of `./src/fieldForceTask` (Expo needs background tasks defined at start-up);
   `mobile/app.config.js`: the `expo-location` options for tracking while punched in
   ("Allow all the time" stays blocked); the `expo-task-manager` package.
5. Generic hooks it uses, not specific to it: `app.features` (listed in `GET /api/config`),
   `app.whatsappHandlers` (the shared WhatsApp webhook offers each incoming message to these
   first; Field Force takes only its own reason buttons, `ff:` payloads), `app.notify`, and
   the `{ lane: "self" }` route option.

To remove the module completely: delete the parts in the first table and these lines, then
drop the `ff_` tables.

## What it reads from the HRMS (read-only)

Employees, branches, managers, punches (`shifts`), leave days, on-duty requests, holidays,
optional-holiday choices, rosters and weekly offs: to know who is working today and who
has punched in. It never changes attendance, leave or any other HR record.

## Phases

**Phase 1, activation (built).** Field staff (per person: Collection or Sales) get a phone
notification at the morning time if not punched in, a reminder asking for a reason at the
reminder time (answered on the app's Home screen), and their manager and HR get a report at
the report time. Report only: no automatic leave.

**Phase 2, escalation (built, off until set up).**
- WhatsApp: the morning message and the reminder also go as WhatsApp templates; the
  reminder's four quick-reply buttons save the reason. Needs `WHATSAPP_TOKEN` (plus
  `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` for replies) and `FF_WHATSAPP_PHONE_ID`,
  and two templates approved by Meta (names and wording on the portal setup card).
- IVR and AI calls: at the set times, anyone still not punched in and without a reason is
  called by the company's calling provider, once each. The HRMS sends the request to
  `FF_CALL_URL` with `Authorization: Bearer FF_CALL_TOKEN`; the provider reports the key
  pressed to `/api/field-force/calls/callback` with the same token. The message format is at
  the top of `channels.js`, for the provider or a small adapter (Exotel, Knowlarity, a voice-AI
  vendor). `APP_URL` must be set so the provider knows where to call back.
- Every message and call, and its outcome, is kept in `ff_contacts` and shown per person.

**Phase 3, tracking (built, off until switched on).** Field staff are asked in the app to
agree to sharing their location while punched in (they can refuse or withdraw; both are
logged). The phone sends a point every few minutes (default 15) only while the server says
so: company switch on, agreement given, shift open. It stops at punch-out. Android shows a
"Field tracking is on" notification; iPhone shows its location indicator; "Allow all the
time" is never asked. Every check period (default 2 hours) someone who moved less than the
set distance (default 200 m) without logging a customer visit gets a nudge; if it happens
again before they move, their manager is told; no points at all is reported as "no
signal". HR and the person's own manager see distance, visits and alerts per day and the
route on a map (each view logged). Points can also come from a tracker CSV. Points are
deleted after the retention period (default 90 days); visits are kept.

**Not built yet (needs outside access or decisions):** the 9:30 day-plan check (CLU /
Synoriq access) and customer visit verification calls (customer and loan phone numbers,
customer consent, RBI calling-hour rules). Visits logged in the app are the starting point.
