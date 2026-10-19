// Local load check: N employees sign in and punch in at once against an in-process
// server on an in-memory database. Measures the application's own cost (hashing,
// validation, risk rules, serialization), not your network or hosted database.
//   node scripts/bench.mjs [employees=300]
import { randomBytes } from "node:crypto";
import { openPglite } from "../server/pglite.js";
import { createAdmin, passwordHash, tokenHash } from "../server/db.js";
import { createApp } from "../server/index.js";

const N = Number(process.argv[2]) || 300;
const PW = "Temporary-pass-123";
const db = await openPglite();
await createAdmin(db, {
  name: "Owner",
  email: "owner@example.test",
  password: "Owner-password-123",
  companyName: "Bench Ltd",
});
const company = (await db.prepare("SELECT id FROM companies").get()).id;
const site = Number(
  (
    await db
      .prepare(
        "INSERT INTO workplaces(company_id,name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?,?)",
      )
      .run(company, "Office", 26.9124, 75.7873, 150, 50)
  ).lastInsertRowid,
);
const hash = passwordHash(PW);
const people = [];
for (let i = 0; i < N; i++) {
  const email = `e${i}@example.test`;
  const id = Number(
    (
      await db
        .prepare(
          "INSERT INTO users(name,email,password_hash,role,company_id,workplace_id,must_change_password,created_at,employee_code) VALUES(?,?,?,?,?,?,0,?,?)",
        )
        .run(
          `E${i}`,
          email,
          hash,
          "employee",
          company,
          site,
          new Date().toISOString(),
          `E${i}`,
        )
    ).lastInsertRowid,
  );
  const device = `bench-device-${String(i).padStart(10, "0")}`;
  const secret = randomBytes(16).toString("hex");
  await db
    .prepare(
      "INSERT INTO devices(user_id,device_id,platform,model,secret_hash,status,registered_at) VALUES(?,?,?,?,?,'approved',?)",
    )
    .run(
      id,
      device,
      "android",
      "Pixel",
      tokenHash(secret),
      new Date().toISOString(),
    );
  people.push({ email, device, secret });
}
const { server } = createApp({ db });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const stats = (label, times, wall) => {
  const s = [...times].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  console.log(
    `${label.padEnd(18)} n=${s.length}  wall ${(wall / 1000).toFixed(1)}s  ${(s.length / (wall / 1000)).toFixed(0)}/s  p50 ${q(0.5)}ms  p95 ${q(0.95)}ms  max ${s.at(-1)}ms`,
  );
};
async function phase(label, fn) {
  const started = Date.now();
  const times = await Promise.all(
    people.map(async (p) => {
      const t = Date.now();
      const r = await fn(p);
      if (r.status !== 200)
        throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
      return Date.now() - t;
    }),
  );
  stats(label, times, Date.now() - started);
}
const call = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

await phase("sign in", async (p) => {
  const r = await call("/login", {
    email: p.email,
    password: PW,
    native: true,
    device: {
      id: p.device,
      platform: "android",
      model: "Pixel",
      secret: p.secret,
    },
  });
  p.token = r.body.token;
  return r;
});
const loc = () => ({
  latitude: 26.9124,
  longitude: 75.7873,
  accuracy: 10,
  timestamp: Date.now(),
});
const auth = (p) => ({
  Authorization: `Bearer ${p.token}`,
  "X-Device-Id": p.device,
  "X-Device-Secret": p.secret,
});
await phase("open the app (/me)", (p) => call("/me", undefined, auth(p)));
await phase("punch in", (p) =>
  call(
    "/punch",
    {
      action: "in",
      location: loc(),
      signals: { emulator: false, rooted: false },
    },
    auth(p),
  ),
);
await phase("punch out", (p) =>
  call(
    "/punch",
    {
      action: "out",
      location: loc(),
      signals: { emulator: false, rooted: false },
    },
    auth(p),
  ),
);
server.close();
server.closeAllConnections();
await db.close();
