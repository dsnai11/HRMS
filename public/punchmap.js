// ---- Punch map: where people punched in and out on a day, with each workplace's boundary ----
// Leaflet and its stylesheet are served by this app and loaded only when the page opens;
// the map pictures come from OpenStreetMap.
let pmLeaflet = null,
  pmTimer = null;
const pm = { table: { q: "", page: 0 }, date: null, branch: "", show: { in: true, out: true, refused: true, workplaces: true }, odOnly: false, outsideOnly: false };
const PM_COLORS = { in: "#146c53", out: "#2f6fd6", od: "#e08a00", refused: "#c0392b" };

function pmLoadLeaflet() {
  // Both the script and the stylesheet: a map laid out before its styles measures itself wrong.
  const loaded = (el) =>
    new Promise((resolve, reject) => {
      el.onload = resolve;
      el.onerror = reject;
      document.head.append(el);
    });
  pmLeaflet ??= Promise.all([
    loaded(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/vendor/leaflet.css" })),
    loaded(Object.assign(document.createElement("script"), { src: "/vendor/leaflet.js" })),
  ]).catch(() => {
    pmLeaflet = null;
    throw new Error("The map could not be loaded. Refresh the page.");
  });
  return pmLeaflet;
}
const pmDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

async function punchMapPage(id) {
  pm.date ??= today();
  const load = (refresh) =>
    api(`/admin/punch-map?date=${pm.date}${pm.branch ? `&branch_id=${pm.branch}` : ""}${refresh ? "&refresh=1" : ""}`);
  const [data] = await Promise.all([load(false), pmLoadLeaflet()]);
  if (id !== renderId) return;
  const check = (key, label, on) =>
    `<label class="check"><input type="checkbox" data-pm="${key}" ${on ? "checked" : ""}> ${label}</label>`;
  document.querySelector("#content").innerHTML =
    heading(
      "Punch map",
      "Where people punched in and out, and attempts the app refused. Coloured rings are workplace boundaries.",
    ) +
    `<div class="card"><div class="pm-bar">
      <label>Day<input type="date" id="pm-date" value="${pm.date}" max="${today()}"></label>
      <label>Branch<select id="pm-branch"><option value="">All branches</option>${data.branches.map((b) => `<option value="${b.id}" ${String(b.id) === pm.branch ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>
      <div class="pm-checks">${check("in", '<span class="pm-dot pm-in"></span>Punch in', pm.show.in)}${check("out", '<span class="pm-dot pm-out"></span>Punch out', pm.show.out)}${check("refused", '<span class="pm-dot pm-refused"></span>Refused attempts', pm.show.refused)}${check("workplaces", "Workplaces", pm.show.workplaces)}${check("odOnly", '<span class="pm-dot pm-od"></span>OD only', pm.odOnly)}${check("outsideOnly", "Outside the workplace only", pm.outsideOnly)}</div>
    </div><div id="pm-stats" class="pm-stats"></div><div id="pm-map" class="pm-map" role="region" aria-label="Map of punches"></div>
    <p class="muted" id="pm-note"></p></div><div class="card"><h2>Punches</h2><div id="pm-list"></div></div>`;

  const map = L.map("pm-map", { scrollWheelZoom: false, preferCanvas: true }).setView([22.5, 79], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let current = data,
    fitted = false;
  const markers = new Map();

  const draw = () => {
    layer.clearLayers();
    markers.clear();
    const d = current;
    const radiusOf = new Map(d.workplaces.map((w) => [w.name, w.radius]));
    const outside = (p) => p.distance_m > (radiusOf.get(p.workplace_name) ?? 0);
    const points = d.points.filter(
      (p) => pm.show[p.kind] && (!pm.odOnly || p.od) && (!pm.outsideOnly || outside(p)),
    );
    const refused = pm.show.refused && !pm.odOnly ? d.refused : [];
    const bounds = [];
    if (pm.show.workplaces)
      for (const w of d.workplaces) {
        L.circle([w.latitude, w.longitude], { radius: w.radius, color: "#5b6b66", weight: 1, dashArray: "4 4", fillOpacity: 0.06 })
          .bindTooltip(`${esc(w.name)} · ${w.radius} m boundary`)
          .addTo(layer);
        bounds.push([w.latitude, w.longitude]);
      }
    for (const p of points) {
      const color = p.od ? PM_COLORS.od : PM_COLORS[p.kind];
      const m = L.circleMarker([p.latitude, p.longitude], { radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95 })
        .bindPopup(
          `<strong>${esc(p.name)}</strong>${p.employee_code ? ` (${esc(p.employee_code)})` : ""}<br>${p.kind === "in" ? "Punch in" : "Punch out"} ${time(p.at)}${p.od ? `<br>OD: ${esc(p.od_purpose || "")}` : ""}<br>${pmDistance(p.distance_m)} from ${esc(p.workplace_name)} · GPS ±${Math.round(p.accuracy ?? 0)} m${p.branch_name ? `<br>${esc(p.branch_name)}` : ""}`,
        )
        .addTo(layer);
      markers.set(`p${p.shift_id}${p.kind}`, m);
      bounds.push([p.latitude, p.longitude]);
    }
    for (const r of refused) {
      const m = L.circleMarker([r.latitude, r.longitude], { radius: 7, color: PM_COLORS.refused, weight: 2, fillColor: "#fff", fillOpacity: 0.9 })
        .bindPopup(`<strong>${esc(r.name)}</strong> · refused ${r.action === "out" ? "punch out" : "punch in"} ${time(r.at)}<br>${esc(r.reason || "")}`)
        .addTo(layer);
      markers.set(`r${r.id}`, m);
      bounds.push([r.latitude, r.longitude]);
    }
    if (!fitted && bounds.length) {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
      fitted = true;
    }

    const people = new Set(d.points.filter((p) => p.kind === "in").map((p) => p.user_id));
    const odPeople = new Set(d.points.filter((p) => p.od).map((p) => p.user_id));
    const away = new Set(d.points.filter(outside).map((p) => p.user_id));
    document.querySelector("#pm-stats").innerHTML = [
      [people.size, "punched in"],
      [odPeople.size, "on OD"],
      [away.size, "punched outside their workplace"],
      [d.refused.length, "refused attempts"],
    ]
      .map(([n, label]) => `<span class="pm-stat"><strong>${n}</strong> ${label}</span>`)
      .join("");
    document.querySelector("#pm-note").textContent =
      pm.date === today()
        ? `Updates every minute. Last update ${new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: config.timezone }).format(new Date())}.`
        : "";

    const rows = [
      ...points.map((p) => ({ key: `p${p.shift_id}${p.kind}`, at: p.at, p })),
      ...refused.map((r) => ({ key: `r${r.id}`, at: r.at, r })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    pagedList(document.querySelector("#pm-list"), rows, {
      head: "<tr><th>Employee</th><th>What</th><th>Time</th><th>Where</th><th>GPS</th><th></th></tr>",
      row: ({ key, p, r }) => {
        const x = p ?? r;
        const what = p
          ? `<span class="pill ${p.od ? "" : "neutral"}">${p.od ? "OD " : ""}${p.kind === "in" ? "In" : "Out"}</span>${p.od ? `<small>${esc(p.od_purpose || "")}</small>` : ""}`
          : `<span class="pill">Refused</span><small>${esc(r.reason || "")}</small>`;
        const where = p ? `${pmDistance(p.distance_m)} from ${esc(p.workplace_name)}` : "—";
        return `<tr><td>${esc(x.name)}<small>${esc(x.employee_code || "")}${x.branch_name ? ` · ${esc(x.branch_name)}` : ""}</small></td><td>${what}</td><td>${time(x.at)}</td><td>${where}</td><td>±${Math.round(x.accuracy ?? 0)} m</td><td><button class="ghost" data-pm-show="${key}">Show on map</button> <a href="https://www.google.com/maps?q=${x.latitude},${x.longitude}" target="_blank" rel="noreferrer">Google Maps ↗</a></td></tr>`;
      },
      text: ({ p, r }) => `${(p ?? r).name} ${(p ?? r).employee_code || ""} ${(p ?? r).branch_name || ""} ${p?.workplace_name || ""} ${p?.od_purpose || ""}`,
      label: "punches",
      placeholder: "Search name, code, branch or OD purpose",
      state: pm.table,
      wire: (el) =>
        el.querySelectorAll("[data-pm-show]").forEach((b) =>
          b.addEventListener("click", () => {
            const m = markers.get(b.dataset.pmShow);
            if (!m) return;
            document.querySelector("#pm-map").scrollIntoView({ behavior: "smooth", block: "center" });
            map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
            m.openPopup();
          }),
        ),
    });
  };
  draw();

  document.querySelector("#pm-date").onchange = (e) => {
    pm.date = e.target.value || today();
    render();
  };
  document.querySelector("#pm-branch").onchange = (e) => {
    pm.branch = e.target.value;
    render();
  };
  document.querySelectorAll("[data-pm]").forEach((c) =>
    c.addEventListener("change", () => {
      const k = c.dataset.pm;
      if (k in pm.show) pm.show[k] = c.checked;
      else pm[k] = c.checked;
      draw();
    }),
  );
  // Today's map refreshes itself while it stays open.
  clearInterval(pmTimer);
  if (pm.date === today())
    pmTimer = setInterval(async () => {
      if (id !== renderId || !document.querySelector("#pm-map")) return clearInterval(pmTimer);
      try {
        current = await load(true);
        if (id === renderId) draw();
      } catch {
        // offline for a moment; try again next minute
      }
    }, 60000);
}
