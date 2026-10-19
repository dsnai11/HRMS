// Bulk loading from CSV: employees (Employees page) and salaries (Payroll → Salaries).
const PEOPLE_COLUMNS = [
  "employee_code",
  "name",
  "email",
  "phone",
  "gender",
  "date_of_birth",
  "date_of_joining",
  "employment_type",
  "department",
  "designation",
  "branch",
  "branch_state",
  "workplace",
  "manager_code",
];
const SALARY_COLUMNS = [
  "employee_code",
  "monthly_gross",
  "effective_from",
  "pf",
  "esi",
  "pt",
  "tax_regime",
];
const csvRows = async (file) => {
  const table = parseCsv(await file.text());
  const head = (table.shift() ?? []).map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^a-z]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  return table.map((r) =>
    Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])),
  );
};
const sampleCsv = (name, columns, example) => {
  const url = URL.createObjectURL(
    new Blob(["﻿" + columns.join(",") + "\r\n" + example + "\r\n"], {
      type: "text/csv",
    }),
  );
  Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  }).click();
  URL.revokeObjectURL(url);
};
const reportTable = (report, cols) =>
  report.length
    ? `<div class="table-wrap"><table><thead><tr><th>Line</th>${cols.map((c) => `<th>${c[1]}</th>`).join("")}<th>Result</th></tr></thead><tbody>${report
        .slice(0, 80)
        .map(
          (r) =>
            `<tr><td>${r.line}</td>${cols.map((c) => `<td>${esc(r[c[0]] ?? "")}</td>`).join("")}<td>${r.status === "failed" ? `<span class="pill neutral">${esc(r.reason || "failed")}</span>` : `<span class="pill">${esc(r.status)}</span>${r.reason ? `<small>${esc(r.reason)}</small>` : ""}`}</td></tr>`,
        )
        .join(
          "",
        )}</tbody></table></div>${report.length > 80 ? `<p class="muted">Showing the first 80 of ${report.length}.</p>` : ""}`
    : "";
// Sends rows in chunks (password hashing is slow), merging the results.
async function sendChunks(path, rows, extra, size, onProgress) {
  const merged = { report: [], credentials: [], created: 0, failed: 0, ok: 0 };
  for (let i = 0; i < rows.length; i += size) {
    const part = await api(path, { rows: rows.slice(i, i + size), ...extra });
    // Line numbers continue across chunks.
    part.report.forEach((r) => merged.report.push({ ...r, line: r.line + i }));
    merged.credentials.push(...(part.credentials ?? []));
    for (const k of [
      "created",
      "updated",
      "failed",
      "ok",
      "would_create",
      "would_update",
    ])
      merged[k] = (merged[k] ?? 0) + (part[k] ?? 0);
    onProgress?.(Math.min(i + size, rows.length), rows.length);
  }
  return merged;
}

async function importPeopleCard(id) {
  if (!has("employees.write") || id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Import employees from a spreadsheet</h2><p class="muted">Save your sheet as CSV. Columns: ${PEOPLE_COLUMNS.join(", ")}. Only name and email are required. Departments, designations and branches are matched by name; workplaces must already exist. Each person gets a temporary password to hand over.</p></div><div class="actions"><button class="ghost" id="people-sample">Download a sample</button><button id="people-import">Choose a CSV file</button></div></div><input type="file" id="people-file" accept=".csv,text/csv" hidden>`;
  document.querySelector("#content").append(card);
  card.querySelector("#people-sample").onclick = () =>
    sampleCsv(
      "employees-sample.csv",
      PEOPLE_COLUMNS,
      "E1001,Anita Rao,anita@company.com,9876543210,female,1992-05-14,2025-04-01,full_time,Collections,Executive,Jaipur,Rajasthan,Jaipur office,",
    );
  const file = card.querySelector("#people-file");
  card.querySelector("#people-import").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    try {
      const rows = await csvRows(f);
      if (!rows.length) return notice("The file has no rows.", true);
      viewDialog(
        "Import options",
        `<p>${rows.length} rows in <strong>${esc(f.name)}</strong>.</p><label class="check"><input type="checkbox" id="create-missing" checked> Create departments, designations and branches that do not exist yet</label><label class="check"><input type="checkbox" id="update-existing"> Update people who already exist (matched by employee code or email) instead of skipping them. Only the columns you fill in change.</label><div class="actions"><button id="check-file">Check the file</button></div>`,
      );
      document.querySelector("dialog #check-file").onclick = (e) =>
        busy(e.target, async () => {
          const options = {
            create_missing: document.querySelector("dialog #create-missing")
              .checked,
            update_existing: document.querySelector("dialog #update-existing")
              .checked,
          };
          const dry = await sendChunks(
            "/admin/employees/import",
            rows,
            { ...options, dry_run: true },
            150,
          );
          const cols = [
            ["name", "Name"],
            ["email", "Email"],
          ];
          const total = dry.would_create + dry.would_update;
          viewDialog(
            "Check before importing",
            `<p><strong>${dry.would_create}</strong> people will be created${options.update_existing ? ` and <strong>${dry.would_update}</strong> updated` : ""}. <strong>${dry.failed}</strong> rows have problems and will be skipped.</p>${reportTable(dry.report, cols)}${total ? '<div class="actions"><button id="go-import">Import now</button></div>' : ""}`,
          );
          document
            .querySelector("dialog #go-import")
            ?.addEventListener("click", (e2) =>
              busy(e2.target, async () => {
                const done = await sendChunks(
                  "/admin/employees/import",
                  rows,
                  options,
                  100,
                  (n, t) => (e2.target.textContent = `Importing ${n} of ${t}…`),
                );
                const csv =
                  "\uFEFFemployee_code,name,email,temporary_password\r\n" +
                  done.credentials
                    .map((c) =>
                      [c.employee_code, c.name, c.email, c.temp_password]
                        .map(csvField)
                        .join(","),
                    )
                    .join("\r\n");
                viewDialog(
                  "Import finished",
                  `<p><strong>${done.created}</strong> created, <strong>${done.updated}</strong> updated, <strong>${done.failed}</strong> skipped.</p>${done.created ? '<div class="callout">The temporary passwords are shown only now. Download them and hand them to each person; they must change it at first sign-in.</div><div class="actions"><button id="dl-creds">Download passwords (CSV)</button></div>' : ""}${reportTable(
                    done.report.filter(
                      (r) => r.status === "failed" || r.reason,
                    ),
                    cols,
                  )}`,
                );
                document
                  .querySelector("dialog #dl-creds")
                  ?.addEventListener("click", () => {
                    const url = URL.createObjectURL(
                      new Blob([csv], { type: "text/csv" }),
                    );
                    Object.assign(document.createElement("a"), {
                      href: url,
                      download: "temporary-passwords.csv",
                    }).click();
                    URL.revokeObjectURL(url);
                  });
                render();
              }),
            );
        });
    } catch (e) {
      notice(e.message, true);
    }
  };
}
const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function importSalariesCard() {
  if (!has("payroll.manage")) return;
  const tab = document.querySelector("#tab");
  if (!tab || tab.querySelector("#salary-import-card")) return;
  const card = document.createElement("div");
  card.className = "card";
  card.id = "salary-import-card";
  card.innerHTML = `<div class="card-head"><div><h2>Import salaries</h2><p class="muted">CSV with: ${SALARY_COLUMNS.join(", ")}. Required: employee_code, monthly_gross, effective_from (YYYY-MM-DD). pf, esi and pt take yes or no; ESI defaults to yes at ₹21,000 or less. Tax regime is new unless you write old. Needs the salary structure to be set up first.</p></div><div class="actions"><button class="ghost" id="sal-sample">Download a sample</button><button id="sal-import">Choose a CSV file</button></div></div><input type="file" id="sal-file" accept=".csv,text/csv" hidden>`;
  tab.append(card);
  card.querySelector("#sal-sample").onclick = () =>
    sampleCsv(
      "salaries-sample.csv",
      SALARY_COLUMNS,
      "E1001,45000,2026-04-01,yes,no,yes,new",
    );
  const file = card.querySelector("#sal-file");
  card.querySelector("#sal-import").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    try {
      const rows = await csvRows(f);
      if (!rows.length) return notice("The file has no rows.", true);
      const dry = await sendChunks(
        "/admin/payroll/salaries/import",
        rows,
        { dry_run: true },
        300,
      );
      const cols = [["code", "Employee code"]];
      viewDialog(
        "Check before importing",
        `<p><strong>${dry.ok}</strong> salaries are ready to save. <strong>${dry.failed}</strong> rows have problems and will be skipped.</p>${reportTable(dry.report, cols)}${dry.ok ? '<div class="actions"><button id="go-sal">Save salaries</button></div>' : ""}`,
      );
      document.querySelector("dialog #go-sal")?.addEventListener("click", (e) =>
        busy(e.target, async () => {
          const done = await sendChunks(
            "/admin/payroll/salaries/import",
            rows,
            {},
            300,
          );
          document.querySelector("dialog")?.remove();
          notice(`${done.ok} salaries saved, ${done.failed} skipped.`);
          render();
        }),
      );
    } catch (e) {
      notice(e.message, true);
    }
  };
}
