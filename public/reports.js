// ---- Custom reports: choose a data set, columns, filters and a summary; view or download ----
let crMeta = null,
  crDef = null,
  crResult = null;
const CR_OPS = {
  is: "is",
  contains: "contains",
  empty: "is empty",
  not_empty: "is not empty",
  from: "on or after",
  to: "on or before",
  at_least: "at least",
  at_most: "at most",
};
const crBlank = (ds) => ({
  dataset: ds.key,
  columns: [...ds.defaults],
  filters: [],
  sort: { field: ds.defaults[0], dir: "asc" },
  group_by: "",
});
async function customReportsPage(id) {
  crMeta = await api("/admin/report-builder");
  if (id !== renderId) return;
  if (!crDef || !crMeta.datasets.some((d) => d.key === crDef.dataset)) {
    crDef = crBlank(crMeta.datasets[0]);
    crResult = null;
  }
  const ds = crMeta.datasets.find((d) => d.key === crDef.dataset);
  const fieldOpts = (selected, extra = "") =>
    extra + ds.fields.map((f) => `<option value="${f.key}" ${f.key === selected ? "selected" : ""}>${esc(f.label)}</option>`).join("");
  const typeOf = (k) => ds.fields.find((f) => f.key === k)?.type || "text";
  const filterRow = (f, i) => {
    const type = typeOf(f.field);
    const needsValue = !["empty", "not_empty"].includes(f.op);
    return `<div class="cr-filter" data-i="${i}"><select data-f="field" aria-label="Column">${fieldOpts(f.field)}</select><select data-f="op" aria-label="Condition">${crMeta.ops[type]
      .map((o) => `<option value="${o}" ${o === f.op ? "selected" : ""}>${CR_OPS[o]}</option>`)
      .join("")}</select>${needsValue ? `<input data-f="value" type="${type === "date" ? "date" : type === "number" ? "number" : "text"}" value="${esc(f.value ?? "")}" aria-label="Value" maxlength="100">` : "<span></span>"}<button type="button" class="ghost" data-del-filter="${i}" aria-label="Remove filter">✕</button></div>`;
  };
  const result = crResult
    ? `<div class="card"><div class="card-head"><div><h2>Result</h2><p class="muted">${crResult.rows.length} row(s)${crResult.truncated ? " (first 5,000 only; add filters to narrow it)" : ""}${crResult.rows.length > 500 ? ". The table shows the first 500; the download has all." : ""}</p></div><button class="secondary" id="cr-csv">Download CSV</button></div>${
        crResult.rows.length
          ? `<div class="table-wrap"><table><thead><tr>${crResult.columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${crResult.rows
              .slice(0, 500)
              .map((r) => `<tr>${r.map((v) => `<td>${v === null ? '<span class="muted">—</span>' : esc(String(v))}</td>`).join("")}</tr>`)
              .join("")}</tbody></table></div>`
          : empty("No rows", "Nothing matches these filters.")
      }</div>`
    : "";
  document.querySelector("#content").innerHTML =
    heading("Custom reports", "Build your own report from employee, attendance, leave or payroll data. Save it to run again any time.") +
    (crMeta.saved.length
      ? `<div class="card"><h2>Saved reports</h2><div class="cr-saved">${crMeta.saved
          .map(
            (s) =>
              `<span class="cr-chip"><button type="button" class="link" data-load="${s.id}">${esc(s.name)}</button><small>${esc(crMeta.datasets.find((d) => d.key === s.definition.dataset)?.label || "")}${s.created_by ? ` · ${esc(s.created_by)}` : ""}</small><button type="button" class="ghost" data-del-saved="${s.id}" aria-label="Delete ${esc(s.name)}">✕</button></span>`,
          )
          .join("")}</div></div>`
      : "") +
    `<div class="card"><h2>Build a report</h2><div class="cr-grid">
      <label>Data<select id="cr-ds">${crMeta.datasets.map((d) => `<option value="${d.key}" ${d.key === ds.key ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select></label>
      <label>Summarise by<select id="cr-group">${fieldOpts(crDef.group_by, '<option value="">No summary: one row each</option>')}</select></label>
      <label>Sort by<select id="cr-sort">${crDef.group_by ? `<option value="group" ${crDef.sort.field !== "count" ? "selected" : ""}>${esc(ds.fields.find((f) => f.key === crDef.group_by)?.label || "")}</option><option value="count" ${crDef.sort.field === "count" ? "selected" : ""}>Count</option>` : fieldOpts(crDef.sort.field)}</select></label>
      <label>Order<select id="cr-dir"><option value="asc">Ascending (A→Z, oldest, smallest)</option><option value="desc" ${crDef.sort.dir === "desc" ? "selected" : ""}>Descending</option></select></label>
    </div>
    <h3>${crDef.group_by ? "Totals of (number columns only)" : "Columns"}</h3>
    <div class="cr-cols">${ds.fields
      .map((f) => `<label class="check"><input type="checkbox" data-col="${f.key}" ${crDef.columns.includes(f.key) ? "checked" : ""} ${crDef.group_by && f.type !== "number" ? "disabled" : ""}> ${esc(f.label)}</label>`)
      .join("")}</div>
    <h3>Filters</h3><div id="cr-filters">${crDef.filters.map(filterRow).join("") || '<p class="muted">No filters: every row is included.</p>'}</div>
    <div class="actions"><button type="button" class="secondary" id="cr-add-filter">+ Add filter</button><span class="spacer"></span><button type="button" class="ghost" id="cr-reset">Start again</button><button type="button" class="secondary" id="cr-save">Save report</button><button type="button" id="cr-run">Run report</button></div></div>` +
    result;

  const q = (s) => document.querySelector(s);
  const readForm = () => {
    crDef.columns = [...document.querySelectorAll("[data-col]:checked")].map((c) => c.dataset.col);
    crDef.filters = [...document.querySelectorAll(".cr-filter")].map((row) => ({
      field: row.querySelector('[data-f="field"]').value,
      op: row.querySelector('[data-f="op"]').value,
      value: row.querySelector('[data-f="value"]')?.value ?? "",
    }));
    crDef.group_by = q("#cr-group").value;
    const s = q("#cr-sort").value;
    crDef.sort = { field: crDef.group_by ? (s === "count" ? "count" : crDef.group_by) : s, dir: q("#cr-dir").value };
  };
  const send = () => ({ ...crDef, group_by: crDef.group_by || null });
  q("#cr-ds").onchange = (e) => {
    crDef = crBlank(crMeta.datasets.find((d) => d.key === e.target.value));
    crResult = null;
    render();
  };
  q("#cr-group").onchange = () => {
    readForm();
    crDef.sort = { field: crDef.group_by || crDef.columns[0] || ds.defaults[0], dir: "asc" };
    if (crDef.group_by) crDef.columns = crDef.columns.filter((k) => typeOf(k) === "number");
    else if (!crDef.columns.length) crDef.columns = [...ds.defaults];
    render();
  };
  // A changed column or condition can change which inputs a filter row needs.
  document.querySelectorAll('.cr-filter select').forEach(
    (s) =>
      (s.onchange = () => {
        readForm();
        const i = Number(s.closest(".cr-filter").dataset.i);
        if (s.dataset.f === "field") {
          crDef.filters[i].op = crMeta.ops[typeOf(crDef.filters[i].field)][0];
          crDef.filters[i].value = "";
        }
        render();
      }),
  );
  q("#cr-add-filter").onclick = () => {
    readForm();
    crDef.filters.push({ field: ds.fields[0].key, op: crMeta.ops[ds.fields[0].type][0], value: "" });
    render();
  };
  document.querySelectorAll("[data-del-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        readForm();
        crDef.filters.splice(Number(b.dataset.delFilter), 1);
        render();
      }),
  );
  q("#cr-reset").onclick = () => {
    crDef = crBlank(ds);
    crResult = null;
    render();
  };
  q("#cr-run").onclick = (e) =>
    busy(e.target, async () => {
      readForm();
      if (!crDef.group_by && !crDef.columns.length) throw new Error("Choose at least one column.");
      crResult = await api("/admin/report-builder/run", send());
      await render();
    });
  q("#cr-csv")?.addEventListener("click", (e) =>
    busy(e.target, async () => {
      const res = await fetch("/api/admin/report-builder/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(activeCompany ? { "X-Company-Id": String(activeCompany) } : {}),
        },
        body: JSON.stringify({ ...send(), format: "csv" }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Download failed.");
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement("a"), { href: url, download: `${ds.label.split(" ")[0].toLowerCase()}-report-${today()}.csv` }).click();
      URL.revokeObjectURL(url);
    }),
  );
  q("#cr-save").onclick = () => {
    readForm();
    dialog("Save this report", input("name", "Report name", "", 'maxlength="80" required placeholder="e.g. Jaipur headcount by department"'), async (f) => {
      await api("/admin/report-builder/saved", { name: f.name, definition: send() });
      notice("Report saved.");
    });
  };
  document.querySelectorAll("[data-load]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const s = crMeta.saved.find((x) => x.id === Number(b.dataset.load));
          crDef = {
            ...s.definition,
            group_by: s.definition.group_by || "",
            sort: s.definition.sort || { field: s.definition.columns[0], dir: "asc" },
          };
          crResult = await api("/admin/report-builder/run", send());
          await render();
        })),
  );
  document.querySelectorAll("[data-del-saved]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          if (!confirm("Delete this saved report?")) return;
          await api(`/admin/report-builder/saved/${b.dataset.delSaved}`, undefined, "DELETE");
          await render();
        })),
  );
}
