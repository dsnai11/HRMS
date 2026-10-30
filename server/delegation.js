// Approval delegation: while a manager is away, the person they chose decides what the
// manager could decide for their reporting line (leave, corrections, OD trips, comp-off,
// and each step of a multi-level approval). HR rights are never delegated, a delegate
// never acts for someone who delegated to them in turn (no chains), and nobody decides
// their own request.

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.REPORT_TIMEZONE || "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const delegationDay = (now = Date.now()) => dayFormat.format(new Date(now));

/** People who have handed their approvals to `userId` today. */
export async function delegatorsOf(db, userId, day = delegationDay()) {
  return (
    await db
      .prepare(
        "SELECT user_id FROM approval_delegations WHERE delegate_id=? AND cancelled_at IS NULL AND starts_on<=? AND ends_on>=?",
      )
      .all(userId, day, day)
  ).map((r) => r.user_id);
}

/** The approvers plus whoever is standing in for them today. */
export async function withDelegates(db, ids, day = delegationDay()) {
  if (!ids.length) return ids;
  const rows = await db
    .prepare(
      `SELECT DISTINCT delegate_id FROM approval_delegations WHERE user_id IN (${ids.map(() => "?").join(",")}) AND cancelled_at IS NULL AND starts_on<=? AND ends_on>=?`,
    )
    .all(...ids, day, day);
  return [...new Set([...ids, ...rows.map((r) => r.delegate_id)])];
}
