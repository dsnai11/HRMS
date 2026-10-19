// Removes data that should not be kept forever. Punch selfies are personal images, so
// they are deleted after PHOTO_RETENTION_DAYS (default 90); the punch itself stays.
export async function purgeOldSelfies(
  db,
  days = Number(process.env.PHOTO_RETENTION_DAYS) || 90,
  now = Date.now(),
) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  const r = await db
    .prepare("DELETE FROM punch_photos WHERE created_at<?")
    .run(cutoff);
  return r.changes ?? 0;
}
export function scheduleRetention(db) {
  const run = () =>
    purgeOldSelfies(db).then(
      (n) => n && console.log(`Removed ${n} punch selfie(s) past retention.`),
      (e) => console.error("Retention job failed:", e.message),
    );
  void run();
  const timer = setInterval(run, 6 * 3600000);
  timer.unref();
}
