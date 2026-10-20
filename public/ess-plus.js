// Self-service extras: my letters, bank detail change requests.
const BANK_STATUS = {
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
};

async function lettersCard(id) {
  const list = await api("/my-letters");
  if (id !== renderId || !list.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>My employment letters</h2><p class="muted">Your appointment, offer, confirmation, promotion and increment letters, ready to print or save as PDF.</p>${list.map((l) => `<div class="activity"><strong>${esc(l.title)}</strong> <small>${fmtDate(l.date)}</small> <a class="button secondary" target="_blank" rel="noopener" href="/letter.html?type=my&kind=${l.kind}&id=${l.id}">Open</a></div>`).join("")}`;
  document.querySelector("#content").append(card);
}

async function bankCard(id) {
  const rows = await api("/profile/bank-change");
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  const pending = rows.find((r) => r.status === "pending");
  card.innerHTML = `<div class="card-head"><div><h2>Bank account for salary</h2><p class="muted">To protect your pay, a change needs proof (a cancelled cheque or passbook page) and is approved by HR or payroll before it takes effect.</p></div>${pending ? "" : '<button class="secondary" id="bank-change">Change bank details</button>'}</div>${
    rows.length
      ? rows
          .map(
            (r) =>
              `<div class="activity">${esc(r.summary)} · <span class="pill ${r.status === "approved" ? "" : "neutral"}">${BANK_STATUS[r.status]}</span>${r.decision_note ? `<br><small>${esc(r.decision_note)}</small>` : ""}${r.status === "pending" ? ` <button class="ghost" data-cancel-bank="${r.id}">Cancel</button>` : ""}</div>`,
          )
          .join("")
      : '<p class="muted">No changes requested.</p>'
  }`;
  document.querySelector("#content").append(card);
  card.querySelector("#bank-change")?.addEventListener("click", () =>
    dialog(
      "Change bank details",
      `${input("account_holder", "Account holder name", "", "required maxlength=100")}${input("bank_name", "Bank name", "", "required maxlength=60")}${input("bank_account", "Account number", "", 'required inputmode="numeric" maxlength=20')}${input("ifsc", "IFSC", "", 'required maxlength=11 autocapitalize="characters"')}<label class="full">Proof: cancelled cheque or passbook page (PDF, JPG or PNG, up to 2 MB)<input type="file" name="proof" accept="application/pdf,image/jpeg,image/png" required></label>`,
      async (f) => {
        const file = document.querySelector("dialog input[name=proof]")
          .files[0];
        if (!file) throw new Error("Attach the proof.");
        if (file.size > 2 * 1024 * 1024)
          throw new Error("The proof can be up to 2 MB.");
        if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
          throw new Error("Use a PDF, JPG or PNG proof.");
        const doc = await api("/documents", {
          kind: "bank",
          name: "Bank proof",
          mime: file.type,
          data: await toB64(file),
        });
        await api("/profile/bank-change", {
          account_holder: f.account_holder,
          bank_name: f.bank_name,
          bank_account: f.bank_account,
          ifsc: f.ifsc,
          document_id: doc.id,
        });
        notice(
          "Sent for approval. Your current account stays in use until it is approved.",
        );
      },
    ),
  );
  card.querySelectorAll("[data-cancel-bank]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/profile/bank-change/${b.dataset.cancelBank}/cancel`, {});
          render();
        })),
  );
}

// HR and payroll approve other people's bank changes from the Approvals page.
async function bankChangeApprovals(id) {
  if (!has("payroll.manage") && !has("employees.write")) return;
  const rows = await api("/admin/bank-changes");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Bank detail changes</h2><p class="muted">Check the proof matches the account holder before approving. The account number is shown masked.</p><div class="table-wrap"><table><thead><tr><th>Employee</th><th>New account</th><th>Proof</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(r.summary)}</td><td><button class="ghost" data-bank-proof="${r.id}">View</button></td><td><button class="secondary" data-bank-ok="${r.id}">Approve</button> <button class="ghost" data-bank-no="${r.id}">Decline</button></td></tr>`).join("")}</tbody></table></div>`;
  document.querySelector("#content").append(card);
  card
    .querySelectorAll("[data-bank-proof]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openFile(`/api/admin/bank-changes/${b.dataset.bankProof}/proof`)),
    );
  card.querySelectorAll("[data-bank-ok]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/bank-changes/${b.dataset.bankOk}/decision`, {
            decision: "approved",
          });
          notice("Approved. The employee's bank details were updated.");
          await loadMe();
          render();
        })),
  );
  card.querySelectorAll("[data-bank-no]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          "Decline bank change",
          '<label class="full">Reason<input name="note" maxlength="300" required></label>',
          async (f) => {
            await api(`/admin/bank-changes/${b.dataset.bankNo}/decision`, {
              decision: "rejected",
              note: f.note,
            });
            notice("Declined.");
            await loadMe();
          },
        )),
  );
}
