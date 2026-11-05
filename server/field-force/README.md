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
| Server code | `server/field-force/` (this folder): `index.js` is the only entry point |
| Database | `server/migrations/067_field_force.sql` and later `ff_` migrations: tables `ff_staff`, `ff_settings`, `ff_days`, `ff_reports`, … (no columns on shared tables) |
| API | everything under `/api/field-force/` |
| Portal | `public/field-force.js`, the **Field Force** menu group |
| Phone app | `mobile/src/screens/FieldForce.tsx` |
| Tests | `test/field-force-*.test.js` |

## Where it plugs into the rest (the only shared lines)

1. `server/index.js`: the import of `./field-force/index.js`, `registerFieldForce` in the
   route list, `scheduleFieldForce(app)` at start-up, and `/field-force.js` in `STATIC`.
2. `public/index.html`: the `<script src="/field-force.js">` tag.
3. `public/app.js`: the **Field Force** menu group (shown only when `config.features.field_force`),
   its icon, and the `fieldforce` page line.
4. `mobile/src/screens/More.tsx`: `<FieldForceCard … />` on the Home screen.
5. Generic hooks it uses, not specific to it: `app.features` (listed in `GET /api/config`),
   `app.notify`, and the `{ lane: "self" }` route option.

To remove the module completely: delete the parts in the first table and these lines, then
drop the `ff_` tables.

## What it reads from the HRMS (read-only)

Employees, branches, managers, punches (`shifts`), leave days, on-duty requests, holidays,
optional-holiday choices, rosters and weekly offs: to know who is working today and who
has punched in. It never changes attendance, leave or any other HR record.
