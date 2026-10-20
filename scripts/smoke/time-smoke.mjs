import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { createApp } = await import("/home/user/hrms/server/index.js");
const { openPglite } = await import("/home/user/hrms/server/pglite.js");
const { createAdmin, passwordHash } = await import("/home/user/hrms/server/db.js");
const db = await openPglite();
await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
const { server } = createApp({ db });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const co = (await db.prepare("SELECT id FROM companies").get()).id;
const branch = Number((await db.prepare("INSERT INTO branches(company_id,name,state,created_at) VALUES(?,?,?,?)").run(co, "Bengaluru", "Karnataka", new Date().toISOString())).lastInsertRowid);
const site = Number((await db.prepare("INSERT INTO workplaces(company_id,name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?,?)").run(co, "Office", 12.97, 77.59, 150, 50)).lastInsertRowid);
const mk = async (name, email, role) => Number((await db.prepare("INSERT INTO users(name,email,password_hash,role,company_id,created_at,date_of_joining,gender,branch_id,workplace_id,employee_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(name, email, passwordHash("Temporary-pass-123"), role, co, new Date().toISOString(), "2026-01-01", "male", branch, site, "E" + Math.floor(Math.random() * 9000 + 1000))).lastInsertRowid);
const pay = await mk("Pia Payroll", "pay@example.test", "payroll");
const hr = await mk("Hana HR", "hr@example.test", "hr");
const boss = await mk("Boss Admin", "boss@example.test", "admin");
const emp = await mk("Esha Employee", "e@example.test", "employee");
await db.prepare("UPDATE companies SET attendance_start_date='2026-09-01' WHERE id=?").run(co);
for (let d = 1; d <= 30; d++) {
  const date = `2026-09-${String(d).padStart(2, "0")}`;
  if (new Date(date + "T00:00:00Z").getUTCDay() === 0) continue;
  await db.prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,day_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(emp, site, "Office", 12.97, 77.59, 150, 50, new Date(`${date}T04:00:00Z`).toISOString(), 12.97, 77.59, 10, new Date(`${date}T13:00:00Z`).toISOString(), "full_day");
}
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors = [];
const session = async (email, fn) => {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1100 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/401|404/.test(m.text()) && errors.push(`${email} console: ${m.text()}`));
  await page.goto(base);
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", "Temporary-pass-123");
  await page.click("button:has-text('Sign in')");
  await page.waitForSelector(".content");
  await fn(page, ctx);
  await ctx.close();
};
await db.prepare("UPDATE users SET must_change_password=0").run();
const tab = async (page, label) => { await page.click(`button[data-tab]:has-text("${label}")`); await page.waitForTimeout(500); };

const esha = (await db.prepare("SELECT id FROM users WHERE email='e@example.test'").get()).id;
await db.prepare("UPDATE users SET manager_id=(SELECT id FROM users WHERE email='hr@example.test') WHERE id=?").run(esha);
await db.prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,day_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(esha, site, "Office", 12.97, 77.59, 150, 50, "2026-10-18T04:00:00Z", 12.97, 77.59, 10, "2026-10-18T13:00:00Z", "full_day");
await session("e@example.test", async (page) => {
  await page.click("nav >> text=Time off");
  await page.waitForSelector("#claim-co");
  await page.click("#claim-co");
  await page.fill("dialog input[name=worked_on]", "2026-10-18");
  await page.fill("dialog input[name=reason]", "Audit support");
  await page.click("dialog button[type=submit]");
  await page.waitForSelector("td:has-text('Waiting')");
  console.log("claim shown:", (await page.innerText("tr:has-text('Audit support')")).replace(/\s+/g, " "));
});
await session("hr@example.test", async (page) => {
  await page.click("nav >> text=Approvals");
  await page.waitForSelector("[data-co-ok]");
  await page.click("[data-co-ok]");
  await page.waitForTimeout(800);
  await page.click("nav >> text=Team calendar");
  await page.waitForSelector(".team-day");
  console.log("calendar cells:", await page.locator(".team-day").count());
  await page.screenshot({ path: "/tmp/claude-0/portal-smoke/teamcal.png" });
  await page.click("nav >> text=Organization");
  await page.waitForSelector("text=Departments");
  await page.click("nav >> text=Workplaces");
  await page.waitForTimeout(600);
  const seed = await page.$("#seed-shifts");
  console.log("seed button on attendance page:", Boolean(seed));
  if (seed) { await seed.click(); await page.waitForSelector("td:has-text('Night shift')"); console.log("templates listed"); }
});
await session("e@example.test", async (page) => {
  await page.click("nav >> text=Time off");
  await page.waitForSelector("text=Compensatory Off");
  console.log("balance tile:", (await page.innerText(".stats")).replace(/\s+/g, " ").slice(0, 120));
});
console.log("errors:", errors);
await browser.close(); server.close(); await db.close(); process.exit(0);
