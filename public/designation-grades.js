// Designations and their grades: the import from the company's sheet, the grades of one
// designation, and the grade list in the employee form (allowed grades first).

// ---- reading the sheet: .xlsx (read here, no outside library) or .csv ------------------------------
async function dgZipReader(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("This file is not an Excel workbook. Save it as .xlsx or .csv.");
  const files = new Map();
  let p = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    const nameLength = view.getUint16(p + 28, true);
    files.set(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength)), {
      method: view.getUint16(p + 10, true),
      size: view.getUint32(p + 20, true),
      at: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return async (name) => {
    const f = files.get(name.replace(/^\//, ""));
    if (!f) return null;
    const start = f.at + 30 + view.getUint16(f.at + 26, true) + view.getUint16(f.at + 28, true);
    const data = bytes.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  };
}
// Every sheet of a workbook as rows of { line, cells }.
async function dgXlsxSheets(file) {
  const read = await dgZipReader(await file.arrayBuffer());
  const xml = (text) => new DOMParser().parseFromString(text || "<x/>", "application/xml");
  const texts = (el) => [...el.getElementsByTagName("t")].map((t) => t.textContent).join("");
  const shared = [...xml(await read("xl/sharedStrings.xml")).getElementsByTagName("si")].map(texts);
  const targets = new Map(
    [...xml(await read("xl/_rels/workbook.xml.rels")).getElementsByTagName("Relationship")].map((r) => [
      r.getAttribute("Id"),
      r.getAttribute("Target"),
    ]),
  );
  const sheets = [];
  for (const sheet of xml(await read("xl/workbook.xml")).getElementsByTagName("sheet")) {
    const target = targets.get(sheet.getAttribute("r:id")) || "";
    const doc = xml(await read(target.startsWith("/") ? target : `xl/${target}`));
    const rows = [];
    for (const row of doc.getElementsByTagName("row")) {
      const cells = [];
      for (const c of row.getElementsByTagName("c")) {
        const col = (c.getAttribute("r") || "A").replace(/\d+/g, "");
        const index = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        const type = c.getAttribute("t");
        cells[index] = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(c) : v;
      }
      rows.push({ line: Number(row.getAttribute("r")) || rows.length + 1, cells: [...cells].map((x) => x ?? "") });
    }
    sheets.push(rows);
  }
  return sheets;
}
// The Designation and Grade columns of the first sheet that has them.
async function dgReadSheet(file) {
  const sheets = /\.xlsx$/i.test(file.name)
    ? await dgXlsxSheets(file)
    : [parseCsv(await file.text()).map((cells, i) => ({ line: i + 1, cells }))];
  for (const rows of sheets) {
    const at = rows.findIndex((r) => r.cells.some((c) => /designation/i.test(c)));
    if (at < 0) continue;
    const head = rows[at].cells;
    const d = head.findIndex((c) => /designation/i.test(c));
    const g = head.findIndex((c, i) => i !== d && /grade/i.test(c));
    if (g < 0) continue;
    return rows.slice(at + 1).map((r) => ({ line: r.line, designation: r.cells[d] ?? "", grades: r.cells[g] ?? "" }));
  }
  throw new Error("The sheet needs a column headed Designation and a column headed Grade.");
}

// ---- Organization → Designations → Import from sheet -------------------------------------------------
const DG_STATUS = { new: "New", updated: "Updated", unchanged: "No change" };
function dgReport(r) {
  const added = r.grades.filter((g) => g.status === "new");
  const count = (s) => r.designations.filter((d) => d.status === s).length;
  return `${r.problems.length ? `<div class="full"><p class="error-text">Fix these lines in the sheet, then choose it again:</p><ul>${r.problems.map((p) => `<li>Line ${p.line}: ${esc(p.reason)}</li>`).join("")}</ul></div>` : ""}<p class="full">${r.designations.length} designations: ${count("new")} new, ${count("updated")} updated, ${count("unchanged")} with no change. ${r.grades.length} grades${added.length ? `, of which ${added.length} new (${esc(added.map((g) => g.name).join(", "))})` : ""}.</p>${r.notInSheet.length ? `<p class="full muted">Not in the sheet, left as they are: ${r.notInSheet.map((d) => `${esc(d.name)} (${d.employees} ${d.employees === 1 ? "person" : "people"})`).join(", ")}. Rename them under Edit to a name in the sheet, or switch them off.</p>` : ""}<div class="full table-wrap"><table><thead><tr><th>Line</th><th>Designation</th><th>Grades</th><th></th></tr></thead><tbody>${r.designations.map((d) => `<tr><td>${d.line}</td><td>${esc(d.name)}</td><td>${esc(d.grades.join(", "))}</td><td><span class="pill ${d.status === "unchanged" ? "neutral" : ""}">${DG_STATUS[d.status]}</span>${d.note ? `<small>${esc(d.note)}</small>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function dgImportDialog() {
  let rows = null,
    report = null;
  dialog(
    "Import designations and grades",
    `<p class="full muted">Choose the designation and grade sheet (.xlsx or .csv) with a Designation column and a Grade column. A cell may hold several designations split by "/" and several grades split by commas. You see what will change before anything is saved; designations not in the sheet are left as they are.</p><label class="full">Sheet<input type="file" id="dg-file" accept=".xlsx,.csv,text/csv"></label><div class="full" id="dg-report"></div>`,
    async () => {
      if (!report) throw new Error("Choose the sheet first.");
      if (report.problems.length) throw new Error("Fix the lines listed above in the sheet, then choose it again.");
      const done = await api("/admin/designations/import", { rows, apply: true });
      const changed = done.designations.filter((d) => d.status !== "unchanged").length;
      notice(`Imported: ${changed} designations added or updated, ${done.grades.filter((g) => g.status === "new").length} grades added.`);
    },
  );
  const out = document.querySelector("dialog #dg-report");
  document.querySelector("dialog #dg-file").onchange = async (e) => {
    rows = report = null;
    const file = e.target.files[0];
    if (!file) return (out.innerHTML = "");
    out.innerHTML = '<p class="muted">Reading the sheet…</p>';
    try {
      rows = await dgReadSheet(file);
      report = await api("/admin/designations/import", { rows, apply: false });
      out.innerHTML = `<div class="form-grid">${dgReport(report)}</div>`;
    } catch (err) {
      out.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    }
  };
}

// ---- Organization → Designations → Grades (one designation) -----------------------------------------
async function dgGradesDialog(designation) {
  const grades = (await api("/admin/grades")).filter((g) => g.active).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const chosen = new Set(String(designation.grade_ids || "").split(",").filter(Boolean).map(Number));
  dialog(
    `Grades for ${designation.name}`,
    grades.length
      ? `<p class="full muted">People with this designation are expected to have one of these grades. Another grade can still be saved, with a warning. Leave all unticked to allow any grade.</p>${grades.map((g) => `<label class="check"><input type="checkbox" name="g${g.id}" value="${g.id}" ${chosen.has(g.id) ? "checked" : ""}> ${esc(g.name)}</label>`).join("")}`
      : '<p class="full muted">There are no grades yet. Add them under the Grades tab, or use Import from sheet.</p>',
    async (b) => {
      await api(`/admin/designations/${designation.id}/grades`, { grade_ids: Object.values(b).map(Number) }, "PUT");
      notice("Grades saved.");
    },
  );
}

// ---- employee form: the designation's grades first ---------------------------------------------------
function dgWireEmployeeForm(org) {
  const form = document.querySelector("dialog form");
  const designation = form?.querySelector('[name="designation_id"]');
  const grade = form?.querySelector('[name="grade_id"]');
  if (!designation || !grade || !(org.grades || []).length) return;
  const allowed = new Map();
  for (const [d, g] of org.designation_grades || []) allowed.set(d, [...(allowed.get(d) || []), g]);
  // On a line of its own under the grade, so the fields beside it keep their height.
  const hint = document.createElement("p");
  hint.className = "full muted";
  (grade.closest("label") || grade).after(hint);
  const opt = (g, selected) => `<option value="${g.id}" ${g.id === selected ? "selected" : ""}>${esc(g.name)}</option>`;
  const update = () => {
    const selected = Number(grade.value) || null;
    const d = org.designations.find((x) => x.id === Number(designation.value));
    const ids = new Set(d ? allowed.get(d.id) || [] : []);
    const fits = org.grades.filter((g) => ids.has(g.id));
    grade.innerHTML = `<option value="">— None —</option>${
      fits.length
        ? `<optgroup label="Grades for ${esc(d.name)}">${fits.map((g) => opt(g, selected)).join("")}</optgroup><optgroup label="Other grades">${org.grades
            .filter((g) => !ids.has(g.id))
            .map((g) => opt(g, selected))
            .join("")}</optgroup>`
        : org.grades.map((g) => opt(g, selected)).join("")
    }`;
    hint.textContent = !fits.length
      ? ""
      : selected && !ids.has(selected)
        ? `Not one of the grades for ${d.name} (${fits.map((g) => g.name).join(", ")}). It can still be saved.`
        : `Grades for ${d.name}: ${fits.map((g) => g.name).join(", ")}`;
    const odd = Boolean(selected && fits.length && !ids.has(selected));
    hint.className = `full ${odd ? "error-text" : "muted"}`;
  };
  designation.addEventListener("change", update);
  grade.addEventListener("change", update);
  update();
}
