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

const cand = Number((await db.prepare("INSERT INTO candidates(company_id,name,email,phone,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(co, "Asha Verma", "asha@example.test", "9876543210", "offer", new Date().toISOString(), new Date().toISOString())).lastInsertRowid);
await db.prepare("INSERT INTO offers(company_id,candidate_id,designation,monthly_gross,joining_date,status,created_at) VALUES(?,?,?,?,?,?,?)").run(co, cand, "Branch Manager", 50000, "2099-01-10", "sent", new Date().toISOString());
let link;
await session("hr@example.test", async (page) => {
  await page.click("nav >> text=Hiring & exits");
  await tab(page, "Candidates");
  await page.click("[data-cand]");
  await page.waitForSelector("dialog #pre-invite");
  await page.click("dialog #pre-invite");
  await page.waitForSelector("#join-link");
  link = await page.inputValue("#join-link");
  console.log("link", link);
});
// candidate, no login, on a phone-sized screen
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("join pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("join console: " + m.text()));
  await page.goto(link.replace(/^https?:\/\/[^/]+/, base).replace(/^\//, base + "/") );
  await page.waitForSelector("#accept");
  await page.fill("#accept input[name=full_name]", "Asha Verma");
  await page.click("#accept button[type=submit]");
  await page.waitForSelector("#details");
  await page.fill("input[name=date_of_birth]", "1995-04-12");
  await page.fill("input[name=address]", "12 MI Road, Jaipur");
  await page.fill("input[name=emergency_name]", "Ravi Verma");
  await page.fill("input[name=emergency_phone]", "9811111111");
  await page.fill("input[name=pan]", "ABCDE1234F");
  await page.fill("input[name=account_holder]", "Asha Verma");
  await page.fill("input[name=bank_name]", "HDFC Bank");
  await page.fill("input[name=bank_account]", "123456789012");
  await page.fill("input[name=ifsc]", "HDFC0001234");
  await page.fill("input[name=edu_degree_0]", "B.Com");
  for (const kind of ["id_proof", "address_proof"]) {
    await page.selectOption("#doc-kind", kind);
    await page.setInputFiles("#doc-file", "/tmp/claude-0/portal-smoke/sample.pdf");
    await page.click("#doc-add");
    await page.waitForSelector(`.join-doc:has-text("${kind === "id_proof" ? "ID proof" : "Address proof"}")`);
  }
  console.log("address kept after upload:", await page.inputValue("input[name=address]"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log("horizontal overflow on phone:", overflow);
  await page.screenshot({ path: "/tmp/claude-0/portal-smoke/join.png", fullPage: true });
  await page.click("#details button[type=submit]");
  await page.waitForSelector("text=Your details are with HR");
  await ctx.close();
}
await session("hr@example.test", async (page) => {
  await page.click("nav >> text=Hiring & exits");
  await tab(page, "Onboarding");
  await page.waitForSelector("text=Joining soon");
  console.log("joining soon row:", await page.innerText("td:has-text('Asha Verma')"));
  await tab(page, "Candidates");
  await page.click("[data-cand]");
  await page.waitForSelector("dialog #pre-approve");
  while (await page.$('dialog [data-pre-verify][data-on="1"]')) { await page.click('dialog [data-pre-verify][data-on="1"]'); await page.waitForTimeout(500); }
  await page.click("dialog #pre-approve");
  await page.waitForSelector("dialog >> text=Verified");
  await page.screenshot({ path: "/tmp/claude-0/portal-smoke/preboarding-hr.png", fullPage: true });
  // probation card renders
  await page.click("dialog #close");
  await tab(page, "Onboarding");
  await page.waitForSelector("text=Probation reviews");
});
console.log("errors:", errors);
await browser.close();
server.close();
await db.close();
process.exit(0);
