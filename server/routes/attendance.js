import { HttpError } from "../http.js";
import { checkLocation } from "../geo.js";
import { assessPunch, parseSignals } from "../risk.js";
import { evaluatePunchIn, halfDayReasons } from "../policy.js";
import { deviceFromHeaders } from "../devices.js";

// One shift per local day: the most recent finished shift that started today.
export async function finishedToday(app, userId, nowMs) {
  const last = await app.db
    .prepare(
      "SELECT * FROM shifts WHERE user_id=? AND out_at IS NOT NULL AND in_at>=? ORDER BY id DESC LIMIT 1",
    )
    .get(userId, new Date(nowMs - 172800000).toISOString());
  return last &&
    app.dayOf(last.in_at) === app.dayOf(new Date(nowMs).toISOString())
    ? last
    : null;
}

async function recordPunchEvent(app, user, event) {
  const finite = (n) => (Number.isFinite(n) ? n : null);
  await app.db
    .prepare(
      "INSERT INTO punch_events(user_id,shift_id,action,outcome,reason,flags,device_row_id,latitude,longitude,accuracy,signals,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      user.id,
      event.shiftId ?? null,
      event.action,
      event.outcome,
      event.reason ?? null,
      JSON.stringify(event.flags || []),
      event.deviceId ?? null,
      finite(event.location?.latitude),
      finite(event.location?.longitude),
      finite(event.location?.accuracy),
      JSON.stringify(event.signals || {}),
      new Date(app.clock()).toISOString(),
    );
}

export function registerAttendance(router, app) {
  const { db, transaction, rateLimit, clock, policy, timezone } = app;

  router.get("/api/shifts", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT * FROM shifts WHERE user_id=? ORDER BY id DESC LIMIT 100",
        )
        .all(user.id),
    ),
  );

  // A small JPEG taken at the moment of the punch, when the company asks for one.
  async function readSelfie(value, companyId) {
    const required = (
      await db
        .prepare("SELECT require_selfie FROM companies WHERE id=?")
        .get(companyId)
    ).require_selfie;
    if (!value) {
      if (required)
        throw new HttpError(422, "Take a selfie to punch.", "selfie_required");
      return null;
    }
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9+/=]+$/.test(value) ||
      value.length > 240000
    )
      throw new HttpError(400, "The selfie is not valid.", "selfie_invalid");
    if (Buffer.from(value.slice(0, 8), "base64")[0] !== 0xff)
      throw new HttpError(400, "The selfie must be a JPEG.", "selfie_invalid");
    return value;
  }
  router.post("/api/punch", async ({ req, user, body, send }) => {
    rateLimit(`punch:${user.id}`, 60);
    const b = await body(300000);
    if (!["in", "out"].includes(b.action))
      throw new HttpError(400, "Choose punch-in or punch-out.");
    const signals = parseSignals(b.signals);
    let device = null;
    try {
      if (!req.headers.authorization?.startsWith("Bearer "))
        throw new HttpError(
          403,
          "Attendance can only be recorded from the company mobile app.",
          "web_punch_blocked",
        );
      device = await deviceFromHeaders(app, user, req);
      if (!device)
        throw new HttpError(
          403,
          "This phone is not registered. Sign in again from the company app.",
          "device_unknown",
        );
      if (device.status !== "approved")
        throw new HttpError(
          403,
          device.status === "pending"
            ? "Your phone is waiting for administrator approval."
            : "This phone is no longer authorised. Contact your administrator.",
          `device_${device.status}`,
        );
      const result = await transaction(async () => {
        const nowMs = clock();
        const open = await db
          .prepare("SELECT * FROM shifts WHERE user_id=? AND out_at IS NULL")
          .get(user.id);
        const done = open ? null : await finishedToday(app, user.id, nowMs);
        if (b.action === "in" && open)
          throw new HttpError(409, "You already have an active shift.");
        if (b.action === "in" && done)
          throw new HttpError(
            409,
            "Today's shift is already complete. Attendance is one shift per day.",
          );
        // A second punch-out on the same day replaces the earlier one.
        const target = open || (b.action === "out" ? done : null);
        if (b.action === "out" && !target)
          throw new HttpError(409, "There is no active shift to end.");
        const site = target
          ? {
              id: target.workplace_id,
              name: target.workplace_name,
              latitude: target.site_latitude,
              longitude: target.site_longitude,
              radius: target.radius,
              max_accuracy: target.max_accuracy,
            }
          : await db
              .prepare("SELECT * FROM workplaces WHERE id=?")
              .get(user.workplace_id ?? -1);
        if (!site)
          throw new HttpError(
            422,
            "Ask your administrator to assign a workplace.",
          );
        checkLocation(b.location, site, nowMs);
        const selfie = await readSelfie(b.selfie, user.company_id);
        const { latitude, longitude, accuracy } = b.location;
        const risk = assessPunch({
          signals,
          location: b.location,
          now: nowMs,
          previous: await db
            .prepare(
              "SELECT latitude,longitude,created_at FROM punch_events WHERE user_id=? AND outcome='accepted' ORDER BY id DESC LIMIT 3",
            )
            .all(user.id),
        });
        if (risk.reject)
          throw Object.assign(new HttpError(422, risk.reject, risk.flags[0]), {
            flags: risk.flags,
          });
        const now = new Date(nowMs).toISOString();
        let id = target?.id;
        const rules =
          b.action === "in" ? evaluatePunchIn(policy, nowMs, timezone) : null;
        if (b.action === "in")
          id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,required_out_at,day_type,half_day_reasons) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  user.id,
                  site.id,
                  site.name,
                  site.latitude,
                  site.longitude,
                  site.radius,
                  site.max_accuracy,
                  now,
                  latitude,
                  longitude,
                  accuracy,
                  rules.requiredOutAt,
                  rules.late ? "half_day" : null,
                  JSON.stringify(
                    halfDayReasons({
                      late: rules.late,
                      requiredOutAt: rules.requiredOutAt,
                    }),
                  ),
                )
            ).lastInsertRowid,
          );
        else {
          const reasons = halfDayReasons({
            late: JSON.parse(target.half_day_reasons || "[]").includes(
              "late_in",
            ),
            requiredOutAt: target.required_out_at || target.in_at,
            outMs: nowMs,
          });
          await db
            .prepare(
              "UPDATE shifts SET out_at=?,out_latitude=?,out_longitude=?,out_accuracy=?,day_type=?,half_day_reasons=? WHERE id=?",
            )
            .run(
              now,
              latitude,
              longitude,
              accuracy,
              reasons.length ? "half_day" : "full_day",
              JSON.stringify(reasons),
              id,
            );
        }
        if (selfie)
          await db
            .prepare(
              "INSERT INTO punch_photos(shift_id,kind,data,created_at) VALUES(?,?,?,?) ON CONFLICT (shift_id,kind) DO UPDATE SET data=EXCLUDED.data,created_at=EXCLUDED.created_at",
            )
            .run(id, b.action, selfie, now);
        await recordPunchEvent(app, user, {
          action: b.action,
          outcome: "accepted",
          shiftId: id,
          flags: risk.flags,
          deviceId: device.id,
          location: b.location,
          signals,
        });
        await db
          .prepare("UPDATE devices SET last_seen_at=? WHERE id=?")
          .run(now, device.id);
        await app.audit(user, `punch_${b.action}`, {
          shiftId: id,
          workplaceId: site.id,
          flags: risk.flags,
        });
        return await db.prepare("SELECT * FROM shifts WHERE id=?").get(id);
      });
      return send(200, result);
    } catch (e) {
      // Keep evidence of refused attempts; conflicts are ordinary state errors.
      if (e instanceof HttpError && [400, 403, 422].includes(e.status))
        await recordPunchEvent(app, user, {
          action: b.action,
          outcome: "rejected",
          reason: e.message,
          flags: e.flags || (e.code ? [e.code] : []),
          deviceId: device?.id,
          location: b.location,
          signals,
        }).catch((err) => console.error(err));
      throw e;
    }
  });
}
