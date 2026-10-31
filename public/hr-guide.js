// The HR guide page: how to run the HRMS, for the HR team only. The text comes from
// the server, which sends it only to people with HR, payroll or admin rights.
let guideArea = "";
let guideQuery = "";

async function hrGuidePage(id) {
  const topics = await api("/hr-guide");
  if (id !== renderId) return;
  const areas = [...new Set(topics.map((t) => t.area))];
  if (guideArea && !areas.includes(guideArea)) guideArea = "";
  document.querySelector("#content").innerHTML =
    heading(
      "HR Guide",
      "How the HR team runs this HRMS, step by step. Only people with HR, payroll or admin rights can see this page.",
    ) +
    `<div class="card"><div class="card-head"><div><h2>Find a topic</h2><p class="muted">Type what you want to do, such as “run payroll” or “approve a phone”. You can also ask Laxmi in plain words.</p></div>${me.role !== "super_admin" ? '<button class="secondary" id="guide-ask">Ask Laxmi →</button>' : ""}</div><input id="guide-q" type="search" placeholder="Search the guide" value="${esc(guideQuery)}" aria-label="Search the guide" autocomplete="off"><div class="tabbar guide-areas">${["", ...areas]
      .map(
        (a) =>
          `<button class="${a === guideArea ? "" : "secondary"}" data-area="${esc(a)}">${esc(a || "All")}</button>`,
      )
      .join("")}</div></div><div id="guide-list"></div>`;
  const list = document.querySelector("#guide-list");
  const show = () => {
    const words = guideQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = topics.filter(
      (t) =>
        (!guideArea || t.area === guideArea) &&
        words.every((w) =>
          [t.title, t.area, t.who, t.keywords, ...t.steps, ...t.tips]
            .join(" ")
            .toLowerCase()
            .includes(w),
        ),
    );
    list.innerHTML = shown.length
      ? areas
          .filter((a) => shown.some((t) => t.area === a))
          .map(
            (a) =>
              `<div class="card"><div class="eyebrow">${esc(a)}</div>${shown
                .filter((t) => t.area === a)
                .map(
                  (t) =>
                    `<details class="guide-topic"${words.length ? " open" : ""}><summary><strong>${esc(t.title)}</strong> <span class="pill neutral">${esc(t.who)}</span></summary><ol>${t.steps
                      .map((s) => `<li>${esc(s)}</li>`)
                      .join("")}</ol>${t.tips
                      .map((s) => `<div class="callout">${esc(s)}</div>`)
                      .join("")}</details>`,
                )
                .join("")}</div>`,
          )
          .join("")
      : empty(
          "Nothing matches",
          "Try fewer words, or ask Laxmi. Raise a helpdesk ticket for anything the guide does not cover.",
        );
  };
  show();
  const q = document.querySelector("#guide-q");
  q.oninput = () => {
    guideQuery = q.value.trim();
    show();
  };
  document.querySelectorAll("[data-area]").forEach(
    (b) =>
      (b.onclick = () => {
        guideArea = b.dataset.area;
        document
          .querySelectorAll("[data-area]")
          .forEach((x) => x.classList.toggle("secondary", x !== b));
        show();
      }),
  );
  const ask = document.querySelector("#guide-ask");
  if (ask)
    ask.onclick = () => {
      page = "laxmi";
      render();
    };
}
