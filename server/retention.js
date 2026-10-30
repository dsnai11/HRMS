// Removes data that should not be kept forever. Punch selfies are personal images, so
// they are deleted after PHOTO_RETENTION_DAYS (default 90); the punch itself stays.
export async function purgeOldSelfies(
  db,
  days = Number(process.env.PHOTO_RETENTION_DAYS) || 90,
  now = Date.now(),
  blobs = null,
) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  // Files in object storage are deleted first, a batch at a time.
  let removed = 0;
  if (blobs?.configured)
    for (;;) {
      const rows = await db
        .prepare("SELECT id,data FROM punch_photos WHERE created_at<? AND data LIKE 's3:%' LIMIT 200")
        .all(cutoff);
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += 10)
        await Promise.all(rows.slice(i, i + 10).map((r) => blobs.remove(r.data)));
      await db.prepare(`DELETE FROM punch_photos WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
      removed += rows.length;
    }
  const r = await db
    .prepare("DELETE FROM punch_photos WHERE created_at<?")
    .run(cutoff);
  return removed + (r.changes ?? 0);
}
export function scheduleRetention(db, blobs = null) {
  const run = () =>
    purgeOldSelfies(db, undefined, undefined, blobs).then(
      (n) => n && console.log(`Removed ${n} punch selfie(s) past retention.`),
      (e) => console.error("Retention job failed:", e.message),
    );
  void run();
  const timer = setInterval(run, 6 * 3600000);
  timer.unref();
}
