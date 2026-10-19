const slip = document.querySelector("#slip");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const inr = (n) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n ?? 0)}`;
const monthLabel = (m) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${m}-01T00:00:00Z`));

// Indian numbering: crore, lakh, thousand.
function inWords(n) {
  n = Math.round(n);
  if (n === 0) return "Zero";
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const below100 = (x) =>
    x < 20
      ? ones[x]
      : `${tens[Math.floor(x / 10)]}${x % 10 ? ` ${ones[x % 10]}` : ""}`;
  const below1000 = (x) =>
    x >= 100
      ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? ` ${below100(x % 100)}` : ""}`
      : below100(x);
  const parts = [];
  for (const [unit, name] of [
    [10000000, "Crore"],
    [100000, "Lakh"],
    [1000, "Thousand"],
  ]) {
    if (n >= unit) {
      parts.push(`${below1000(Math.floor(n / unit))} ${name}`);
      n %= unit;
    }
  }
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}

(async () => {
  const q = new URLSearchParams(location.search);
  const path = q.get("user")
    ? `/api/admin/payroll/runs/${q.get("run")}/items/${q.get("user")}`
    : `/api/payslips/${q.get("run")}`;
  const res = await fetch(path);
  if (!res.ok) {
    slip.innerHTML = `<p class="error-text">${res.status === 401 ? "Please sign in to the portal first, then reopen this page." : "This payslip is not available."}</p>`;
    return;
  }
  const d = await res.json();
  document.title = `Payslip ${d.month} · ${d.employee.name}`;
  const rows = (list) =>
    list
      .map(
        (x) =>
          `<tr><td>${esc(x.name)}</td><td class="num">${inr(x.amount)}</td></tr>`,
      )
      .join("");
  slip.innerHTML = `<article class="slip"><header><div><h1>${esc(d.company || "")}</h1><p>Payslip for ${monthLabel(d.month)}</p></div><button class="no-print" id="print">Print / save as PDF</button></header>
    <table class="meta"><tr><td>Employee</td><td><strong>${esc(d.employee.name)}</strong></td><td>Employee code</td><td>${esc(d.employee.employee_code || "—")}</td></tr>
    <tr><td>Department</td><td>${esc(d.employee.department || "—")}</td><td>Designation</td><td>${esc(d.employee.designation || "—")}</td></tr>
    <tr><td>Days in month</td><td>${d.days_in_month}</td><td>Paid days</td><td>${d.paid_days}${d.lop_days ? ` (loss of pay ${d.lop_days})` : ""}</td></tr></table>
    <div class="cols"><table><thead><tr><th>Earnings</th><th class="num">Amount</th></tr></thead><tbody>${rows(d.earnings)}</tbody><tfoot><tr><td>Gross earnings</td><td class="num">${inr(d.gross_earnings)}</td></tr></tfoot></table>
    <table><thead><tr><th>Deductions</th><th class="num">Amount</th></tr></thead><tbody>${rows(d.deductions) || '<tr><td colspan="2">None</td></tr>'}</tbody><tfoot><tr><td>Total deductions</td><td class="num">${inr(d.total_deductions)}</td></tr></tfoot></table></div>
    <p class="net"><span>Net pay</span><strong>${inr(d.net_pay)}</strong></p><p class="words">Rupees ${esc(inWords(d.net_pay))} only</p>
    <footer>This is a computer-generated payslip.</footer></article>`;
  slip.querySelector("#print")?.addEventListener("click", () => print());
})();
