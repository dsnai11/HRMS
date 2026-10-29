import { HttpError, isoDate, optionalId } from "../http.js";
import { branchScope } from "../scope.js";
import { distanceMeters } from "../geo.js";
import { addDays, localToUtcMs } from "../calendar.js";

// The punch map: where people punched in and out on a day, and refused attempts, with
// each workplace and its boundary. Branch-limited roles see only their branches.
export function registerPunchMap(router, app) {
  const { db, timezone } = app;

  router.get(
    "/api/admin/punch-map",
    { perm: "attendance.read" },
    async ({ user, companyId, query, send, audit }) => {
      const date = isoDate(query.get("date") || app.dayOf(new Date(app.clock()).toISOString()), "Date");
      const branchId = query.get("branch_id") ? optionalId(Number(query.get("branch_id")), "Branch") : null;
      const from = new Date(localToUtcMs(date, "00:00", timezone)).toISOString(),
        to = new Date(localToUtcMs(addDays(date, 1), "00:00", timezone)).toISOString();
      const scope = branchScope(user);
      const people = `u.company_id=? AND u.role<>'super_admin'${branchId ? " AND u.branch_id=?" : ""}${scope.sql}`;
      const args = [companyId, ...(branchId ? [branchId] : []), ...scope.params];
      if (date > app.dayOf(new Date(app.clock()).toISOString()))
        throw new HttpError(400, "Choose today or an earlier day.");

      const shifts = await db
        .prepare(
          `SELECT s.id,s.user_id,u.name,u.employee_code,b.name branch_name,s.workplace_name,s.site_latitude,s.site_longitude,s.radius,
             s.in_at,s.in_latitude,s.in_longitude,s.in_accuracy,s.out_at,s.out_latitude,s.out_longitude,s.out_accuracy,s.source,s.od_purpose
           FROM shifts s JOIN users u ON u.id=s.user_id LEFT JOIN branches b ON b.id=u.branch_id
           WHERE s.in_at>=? AND s.in_at<? AND ${people} ORDER BY s.in_at`,
        )
        .all(from, to, ...args);
      const points = [];
      for (const s of shifts) {
        const od = s.od_purpose != null;
        const base = {
          shift_id: s.id,
          user_id: s.user_id,
          name: s.name,
          employee_code: s.employee_code,
          branch_name: s.branch_name,
          workplace_name: s.workplace_name,
          od,
          od_purpose: s.od_purpose,
          source: s.source,
        };
        // Imported (biometric) and corrected days have no real phone location.
        if (["imported", "regularized", "work_from_home"].includes(s.source) || (s.source === "on_duty" && !od)) continue;
        for (const [kind, at, lat, lng, acc] of [
          ["in", s.in_at, s.in_latitude, s.in_longitude, s.in_accuracy],
          ["out", s.out_at, s.out_latitude, s.out_longitude, s.out_accuracy],
        ])
          if (at && Number.isFinite(lat) && Number.isFinite(lng))
            points.push({
              ...base,
              kind,
              at,
              latitude: lat,
              longitude: lng,
              accuracy: acc,
              distance_m: Math.round(distanceMeters(lat, lng, s.site_latitude, s.site_longitude)),
            });
      }
      const refused = (
        await db
          .prepare(
            `SELECT e.id,e.user_id,u.name,u.employee_code,b.name branch_name,e.action,e.reason,e.latitude,e.longitude,e.accuracy,e.created_at
             FROM punch_events e JOIN users u ON u.id=e.user_id LEFT JOIN branches b ON b.id=u.branch_id
             WHERE e.outcome='rejected' AND e.created_at>=? AND e.created_at<? AND e.latitude IS NOT NULL AND ${people}
             ORDER BY e.created_at DESC LIMIT 500`,
          )
          .all(from, to, ...args)
      ).map((e) => ({ ...e, at: e.created_at, created_at: undefined }));
      const mine = user.branch_scope?.length ? user.branch_scope : null;
      const wanted = branchId ? [branchId] : mine;
      const workplaces = await db
        .prepare(
          `SELECT w.id,w.name,w.latitude,w.longitude,w.radius FROM workplaces w WHERE w.company_id=?${wanted ? ` AND (w.branch_id IN (${wanted.map(() => "?").join(",")}) OR w.branch_id IS NULL)` : ""} ORDER BY w.name`,
        )
        .all(companyId, ...(wanted ?? []));
      // The page refreshes itself every minute; only opening it is logged.
      if (!query.get("refresh")) await audit("punch_map_viewed", { date, branchId });
      const branches = await db
        .prepare(
          `SELECT id,name FROM branches WHERE company_id=? AND active=1${mine ? ` AND id IN (${mine.map(() => "?").join(",")})` : ""} ORDER BY name`,
        )
        .all(companyId, ...(mine ?? []));
      return send(200, { date, points, refused, workplaces, branches });
    },
  );
}
