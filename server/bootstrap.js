import { openConfiguredDatabase, createAdmin } from "./db.js";
const db = await openConfiguredDatabase();
try {
  await createAdmin(db, {
    name: process.env.ADMIN_NAME || "Administrator",
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  console.log(
    "Administrator created. Remove ADMIN_PASSWORD from your environment after bootstrap.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
