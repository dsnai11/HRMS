// ---- internal chat ------------------------------------------------------------------------------------
// Messages arrive by polling /chat/updates every few seconds while the portal is
// open. Desktop alerts use the browser Notification API once the person allows it.
// Every 10 seconds while the portal is in front, every 30 while it is in a background tab:
// with hundreds of HR and manager browsers open, polling is most of the server's traffic.
const CHAT_POLL_MS = 10000;
const CHAT_POLL_HIDDEN_MS = 30000;
const chat = { latest: null, unread: 0, timer: null, room: null, oldest: null, readers: [] };

function chatBadge() {
  const b = document.querySelector("#chat-n");
  if (!b) return;
  b.textContent = chat.unread ? String(chat.unread) : "";
  b.classList.toggle("on", chat.unread > 0);
}
// Plain fetch, not api(): a background poll must never bounce someone to the
// sign-in screen while they are typing.
async function chatPoll() {
  if (!me || me.role === "super_admin") return chatStop();
  if (document.hidden && Date.now() - (chat.polledAt ?? 0) < CHAT_POLL_HIDDEN_MS) return;
  chat.polledAt = Date.now();
  const since = chat.latest === null ? "" : `?since=${chat.latest}`;
  let data;
  try {
    const res = await fetch(`/api/chat/updates${since}`);
    if (res.status === 401) return chatStop();
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // offline for a moment; try again on the next tick
  }
  const fresh = chat.latest === null ? [] : data.messages;
  chat.latest = data.latest;
  chat.unread = data.unread;
  const open = page === "chat" ? chat.room : null;
  const here = fresh.filter((m) => m.room_id === open);
  if (here.length) {
    chatAppend(here);
    const last = here.at(-1).id;
    await api(`/chat/rooms/${open}/read`, { message_id: last }).catch(() => {});
    chat.unread = Math.max(
      0,
      chat.unread - here.filter((m) => m.user_id !== me.id).length,
    );
  }
  for (const m of fresh)
    if (m.user_id !== me.id && (document.hidden || m.room_id !== open))
      chatAlert(m);
  chatBadge();
  if (fresh.length && page === "chat") chatRooms();
  if (open && document.querySelector("[data-seen]")) {
    const info = await api(`/chat/rooms/${open}`).catch(() => null);
    if (info && chat.room === open) {
      chat.readers = info.members.filter((x) => x.id !== me.id);
      chatTicks();
    }
  }
}
function chatStop() {
  clearInterval(chat.timer);
  chat.timer = null;
  chat.latest = null;
}
function chatInit() {
  if (chat.user !== me.id) {
    // someone else signed in on this page
    chatStop();
    Object.assign(chat, { user: me.id, unread: 0, room: null });
  }
  chatBadge();
  if (chat.timer || me.role === "super_admin") return;
  chatPoll();
  chat.timer = setInterval(chatPoll, CHAT_POLL_MS);
}
function chatAlert(m) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  const n = new Notification(
    m.kind !== "direct" ? `${m.author} in ${m.room_name}` : m.author,
    { body: m.body.slice(0, 140), tag: `chat-${m.room_id}` },
  );
  n.onclick = () => {
    window.focus();
    chat.room = m.room_id;
    page = "chat";
    render();
    n.close();
  };
}

const chatTime = (iso) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    ...(iso.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? {}
      : { day: "numeric", month: "short" }),
  }).format(new Date(iso));
const chatFile = (m) =>
  !m.file_id
    ? ""
    : m.file_mime?.startsWith("image/")
      ? `<a href="/api/chat/files/${m.file_id}" target="_blank" rel="noopener"><img class="chat-img" src="/api/chat/files/${m.file_id}" alt="${esc(m.file_name)}" loading="lazy"></a>`
      : `<a class="chat-file" href="/api/chat/files/${m.file_id}" target="_blank" rel="noopener">📎 ${esc(m.file_name)}</a>`;
const chatBubble = (m) =>
  `<div class="chat-msg ${m.user_id === me.id ? "mine" : ""}" data-msg="${m.id}"><small>${m.user_id === me.id ? "You" : esc(m.author)} · ${chatTime(m.created_at)}${m.user_id === me.id ? ` <button class="link" data-unsend="${m.id}" aria-label="Delete message">delete</button>` : ""}</small>${m.body ? `<div>${esc(m.body).replaceAll("\n", "<br>")}</div>` : ""}${chatFile(m)}${m.user_id === me.id ? `<small class="seen" data-seen="${m.id}"></small>` : ""}</div>`;
// Ticks on my messages: seen by the other person, or by how many in a group.
function chatTicks() {
  document.querySelectorAll("[data-seen]").forEach((el) => {
    const id = Number(el.dataset.seen);
    const seen = chat.readers.filter((r) => r.last_read_id >= id).length;
    el.textContent =
      chat.readers.length <= 1
        ? seen
          ? "✓✓ Seen"
          : "✓ Sent"
        : seen
          ? `✓✓ Seen by ${seen} of ${chat.readers.length}`
          : "✓ Sent";
    el.classList.toggle("on", seen > 0);
  });
}
function chatAppend(messages) {
  const list = document.querySelector("#chat-msgs");
  if (!list) return;
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  for (const m of messages)
    if (!list.querySelector(`[data-msg="${m.id}"]`))
      list.insertAdjacentHTML("beforeend", chatBubble(m));
  list.querySelector(".empty")?.remove();
  chatWireBubbles();
  chatTicks();
  if (stick) list.scrollTop = list.scrollHeight;
}
function chatWireBubbles() {
  document.querySelectorAll("[data-unsend]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/chat/messages/${b.dataset.unsend}`, undefined, "DELETE");
          b.closest(".chat-msg").remove();
          chatRooms();
        })),
  );
}

async function chatRooms() {
  const el = document.querySelector("#chat-rooms");
  if (!el) return;
  const rooms = await api("/chat/rooms");
  el.innerHTML = rooms.length
    ? rooms
        .map(
          (r) =>
            `<button class="chat-room ${r.id === chat.room ? "selected" : ""}" data-room="${r.id}"><span class="avatar ${r.kind === "team" ? "team" : ""}">${r.kind === "team" ? "🛡" : r.kind === "group" ? "#" : initials(r.title)}</span><span class="chat-room-text"><strong>${esc(r.title)}</strong><small>${r.last_body ? `${r.kind !== "direct" && r.last_from ? `${esc(r.last_from.split(" ")[0])}: ` : ""}${esc(r.last_body)}` : r.kind === "team" ? "HR team only" : r.kind === "group" ? `${r.members} people` : "No messages yet"}</small></span>${Number(r.unread) ? `<span class="pill">${r.unread}</span>` : ""}</button>`,
        )
        .join("")
    : empty("No conversations yet", "Start one with New message.");
  el.querySelectorAll("[data-room]").forEach(
    (b) => (b.onclick = () => chatOpen(Number(b.dataset.room))),
  );
}

async function chatOpen(roomId) {
  chat.room = roomId;
  document
    .querySelectorAll("[data-room]")
    .forEach((b) =>
      b.classList.toggle("selected", Number(b.dataset.room) === roomId),
    );
  const pane = document.querySelector("#chat-pane");
  const [info, { messages }] = await Promise.all([
    api(`/chat/rooms/${roomId}`),
    api(`/chat/rooms/${roomId}/messages`),
  ]);
  if (chat.room !== roomId || !pane) return;
  chat.oldest = messages[0]?.id ?? null;
  chat.readers = info.members.filter((x) => x.id !== me.id);
  const title =
    info.kind !== "direct"
      ? info.name
      : (info.members.find((m) => m.id !== me.id)?.name ?? "Former colleague");
  pane.innerHTML = `<div class="chat-head"><div><h2>${esc(title)}</h2><small class="muted">${info.kind === "team" ? `HR team only · ${info.members.length} people · membership follows the HR team chat right` : info.kind === "group" ? `${info.members.length} people` : "Direct message"}</small></div>${info.kind === "group" ? '<button class="secondary" id="chat-members">People</button>' : ""}</div><div class="chat-msgs" id="chat-msgs">${messages.length === 50 ? '<button class="ghost" id="chat-older">Show earlier messages</button>' : ""}${messages.length ? messages.map(chatBubble).join("") : empty("Say hello", "Messages are visible only to the people in this conversation.")}</div><form class="chat-send" id="chat-send"><label class="chat-attach" title="Attach a PDF or photo (up to 2 MB)">📎<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" hidden></label><textarea name="body" rows="2" maxlength="2000" placeholder="Write a message. Enter sends, Shift+Enter adds a line."></textarea><button>Send</button></form><small class="muted" id="chat-picked"></small>`;
  const list = pane.querySelector("#chat-msgs");
  list.scrollTop = list.scrollHeight;
  chatWireBubbles();
  chatTicks();
  pane.querySelector("#chat-older")?.addEventListener("click", (e) =>
    busy(e.target, async () => {
      const older = (
        await api(`/chat/rooms/${roomId}/messages?before=${chat.oldest}`)
      ).messages;
      e.target.remove();
      if (!older.length) return;
      chat.oldest = older[0].id;
      list.insertAdjacentHTML(
        "afterbegin",
        (older.length === 50
          ? '<button class="ghost" id="chat-older-more">Show earlier messages</button>'
          : "") + older.map(chatBubble).join(""),
      );
      chatWireBubbles();
      list
        .querySelector("#chat-older-more")
        ?.addEventListener("click", () => chatOpen(roomId));
    }),
  );
  pane.querySelector("#chat-members")?.addEventListener("click", () =>
    chatMembers(info),
  );
  const form = pane.querySelector("#chat-send");
  const box = form.querySelector("textarea");
  box.focus();
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const picker = form.querySelector("input[type=file]");
  picker.onchange = () =>
    (pane.querySelector("#chat-picked").textContent = picker.files[0]
      ? `Attached: ${picker.files[0].name}`
      : "");
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = box.value.trim();
    const file = picker.files[0];
    if (!text && !file) return;
    busy(e.submitter || form.querySelector("button:not([type])"), async () => {
      if (file) {
        if (file.size > 2 * 1024 * 1024)
          throw new Error("Files can be up to 2 MB.");
        if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
          throw new Error("Share a PDF, JPG or PNG.");
        await api(`/chat/rooms/${roomId}/messages`, {
          body: text,
          file: { name: file.name, mime: file.type, data: await toB64(file) },
        });
        return chatOpen(roomId);
      }
      const r = await api(`/chat/rooms/${roomId}/messages`, { body: text });
      box.value = "";
      chatAppend([
        {
          id: r.id,
          user_id: me.id,
          author: me.name,
          body: text,
          created_at: r.created_at,
        },
      ]);
      list.scrollTop = list.scrollHeight;
      chatRooms();
    });
  };
  const last = messages.at(-1)?.id;
  if (last) {
    await api(`/chat/rooms/${roomId}/read`, { message_id: last });
    const r = await fetch("/api/chat/updates");
    if (r.ok) chat.unread = (await r.json()).unread;
    chatBadge();
    chatRooms();
  }
}

// A people picker inside a dialog: type to search, click to choose.
function chatPicker(container, onPick) {
  const input = container.querySelector("[data-people-q]");
  const out = container.querySelector("[data-people-out]");
  let t;
  const search = async () => {
    const people = await api(
      `/chat/people?q=${encodeURIComponent(input.value.trim())}`,
    );
    out.innerHTML = people.length
      ? people
          .map(
            (p) =>
              `<button type="button" class="notice-row" data-person="${p.id}" data-name="${esc(p.name)}"><strong>${esc(p.name)}</strong><small>${esc([p.designation, p.employee_code].filter(Boolean).join(" · "))}</small></button>`,
          )
          .join("")
      : '<p class="muted">Nobody found.</p>';
    out
      .querySelectorAll("[data-person]")
      .forEach(
        (b) =>
          (b.onclick = () => onPick(Number(b.dataset.person), b.dataset.name)),
      );
  };
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(search, 250);
  });
  search();
  input.focus();
}
const pickerHtml = (label = "Find a colleague") =>
  `<label>${label}<input data-people-q placeholder="Name or employee code" autocomplete="off"></label><div class="chat-pick" data-people-out></div>`;

function chatNewDirect() {
  viewDialog("New message", pickerHtml());
  chatPicker(document.querySelector("dialog"), async (id) => {
    const { id: room } = await api("/chat/direct", { user_id: id });
    document.querySelector("dialog")?.remove();
    chat.room = room;
    await chatRooms();
    await chatOpen(room);
  });
}
function chatNewGroup() {
  const chosen = new Map();
  viewDialog(
    "New group",
    `<label>Group name<input id="group-name" maxlength="60" placeholder="e.g. Jaipur branch"></label>${pickerHtml("Add people")}<p class="muted" id="group-chosen">Nobody added yet.</p><div class="form-actions"><button type="button" id="group-create">Create group</button></div>`,
  );
  const d = document.querySelector("dialog");
  const show = () => {
    d.querySelector("#group-chosen").innerHTML = chosen.size
      ? [...chosen]
          .map(
            ([id, name]) =>
              `<button type="button" class="pill neutral chip" data-unpick="${id}">${esc(name)} ✕</button>`,
          )
          .join(" ")
      : "Nobody added yet.";
    d.querySelectorAll("[data-unpick]").forEach(
      (b) =>
        (b.onclick = () => {
          chosen.delete(Number(b.dataset.unpick));
          show();
        }),
    );
  };
  chatPicker(d, (id, name) => {
    chosen.set(id, name);
    show();
  });
  d.querySelector("#group-create").onclick = (e) =>
    busy(e.target, async () => {
      const { id } = await api("/chat/groups", {
        name: d.querySelector("#group-name").value,
        member_ids: [...chosen.keys()],
      });
      d.remove();
      chat.room = id;
      await chatRooms();
      await chatOpen(id);
    });
}
function chatMembers(info) {
  viewDialog(
    info.name,
    `${info.members.map((m) => `<div class="activity chat-member"><span>${esc(m.name)}${m.is_admin ? ' <span class="pill neutral">admin</span>' : ""}</span>${info.is_admin && m.id !== me.id ? `<button class="ghost" data-remove="${m.id}">Remove</button>` : ""}</div>`).join("")}${info.is_admin ? pickerHtml("Add someone") : ""}<div class="actions spaced"><button class="secondary" id="group-leave">Leave group</button></div>`,
  );
  const d = document.querySelector("dialog");
  const reopen = async () => {
    d.remove();
    await chatOpen(info.id);
    chatMembers(await api(`/chat/rooms/${info.id}`));
  };
  if (info.is_admin)
    chatPicker(d, async (id) => {
      await api(`/chat/rooms/${info.id}/members`, { user_ids: [id] });
      await reopen();
    });
  d.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/chat/rooms/${info.id}/members/${b.dataset.remove}`,
            undefined,
            "DELETE",
          );
          await reopen();
        })),
  );
  d.querySelector("#group-leave").onclick = (e) =>
    busy(e.target, async () => {
      if (!confirm(`Leave ${info.name}? You will no longer see its messages.`))
        return;
      await api(
        `/chat/rooms/${info.id}/members/${me.id}`,
        undefined,
        "DELETE",
      );
      d.remove();
      chat.room = null;
      await render();
    });
}

async function chatPage(id) {
  if (me.role === "super_admin") {
    document.querySelector("#content").innerHTML =
      heading("Messages", "Chat is for employees of a company.") +
      empty("Use an employee login", "The platform owner has no colleagues.");
    return;
  }
  const canGroup = me.is_manager || has("employees.read");
  const askAlerts =
    "Notification" in window && Notification.permission === "default";
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Messages",
      "Chat with colleagues. New messages arrive every few seconds while the portal is open.",
      `<div class="actions">${askAlerts ? '<button class="secondary" id="chat-alerts">Turn on desktop alerts</button>' : ""}${canGroup ? '<button class="secondary" id="chat-group">New group</button>' : ""}<button id="chat-new">New message</button></div>`,
    ) +
    `<div class="card chat"><aside class="chat-rooms" id="chat-rooms"><div class="loading">Loading…</div></aside><section class="chat-pane" id="chat-pane">${empty("Choose a conversation", "Or start a new one.")}</section></div>`;
  document.querySelector("#chat-new").onclick = chatNewDirect;
  document
    .querySelector("#chat-group")
    ?.addEventListener("click", chatNewGroup);
  document
    .querySelector("#chat-alerts")
    ?.addEventListener("click", async (e) => {
      const p = await Notification.requestPermission();
      e.target.remove();
      notice(
        p === "granted"
          ? "Desktop alerts are on for new messages."
          : "Alerts stay off. You can allow them later in your browser's site settings.",
      );
    });
  await chatRooms();
  if (chat.room && id === renderId) await chatOpen(chat.room);
}

// ---- Laxmi, the HR assistant ----------------------------------------------------------------------------
const BOT_LINKS = {
  timeoff: "Time off",
  payslips: "Payslips",
  mine: "My attendance",
  approvals: "Approvals",
  teamcal: "Team calendar",
  policies: "Policies",
  helpdesk: "Helpdesk",
  learning: "My courses",
};
const BOT_SUGGESTIONS = [
  "What is my leave balance?",
  "Apply casual leave tomorrow",
  "Next holidays",
  "When is payday?",
  "Show my last payslip",
  "My attendance this month",
  "My leave history",
  "My training",
];

function botMine(text) {
  return `<div class="chat-msg mine"><div>${esc(text)}</div></div>`;
}
function botReply(a) {
  const links = (a.links || []).filter((l) => BOT_LINKS[l]);
  return `<div class="chat-msg bot" data-answer="${a.id}"><small>Laxmi</small><div>${esc(a.text).replaceAll("\n", "<br>")}</div>${a.action?.type === "leave_request" ? botLeaveCard(a.action) : ""}${links.length ? `<div class="actions">${links.map((l) => `<button class="secondary" data-goto="${l}">${BOT_LINKS[l]} →</button>`).join("")}</div>` : ""}${a.id ? `<div class="bot-rate">${a.helpful === null || a.helpful === undefined ? `Was this helpful? <button class="link" data-rate="1">Yes</button> <button class="link" data-rate="0">No</button>` : a.helpful ? "Thanks for the feedback." : "Thanks. HR will review this answer."}</div>` : ""}</div>`;
}
function botLeaveCard(x) {
  const types = x.options
    .map(
      (o) =>
        `<option value="${o.leave_type_id}" ${o.leave_type_id === x.leave_type_id ? "selected" : ""}>${esc(o.name)}${o.available === null ? "" : ` (${o.available} available)`}</option>`,
    )
    .join("");
  return `<form class="bot-leave form-grid"><label>Leave type<select name="leave_type_id" required>${x.leave_type_id ? "" : '<option value="">Choose…</option>'}${types}</select></label><label>Half day<select name="half_day"><option value="">No, full day(s)</option><option value="first" ${x.half_day === "first" ? "selected" : ""}>First half</option><option value="second" ${x.half_day === "second" ? "selected" : ""}>Second half</option></select></label><label>From<input type="date" name="from_date" value="${esc(x.from_date)}" required></label><label>To<input type="date" name="to_date" value="${esc(x.to_date)}" required></label><label class="full">Reason (optional)<input name="reason" maxlength="500" value="${esc(x.reason || "")}"></label><div class="actions full"><button>Confirm and send for approval</button></div></form>`;
}
function botWire(root) {
  root.querySelectorAll("[data-goto]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.goto;
        render();
      }),
  );
  root.querySelectorAll("[data-answer] [data-rate]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const helpful = b.dataset.rate === "1";
          await api(`/bot/log/${b.closest("[data-answer]").dataset.answer}/feedback`, {
            helpful,
          });
          b.parentElement.textContent = helpful
            ? "Thanks for the feedback."
            : "Thanks. HR will review this answer.";
        })),
  );
  root.querySelectorAll("form.bot-leave").forEach(
    (f) =>
      (f.onsubmit = (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f));
        busy(e.submitter, async () => {
          const r = await api("/leave/requests", {
            leave_type_id: Number(v.leave_type_id),
            from_date: v.from_date,
            to_date: v.half_day ? v.from_date : v.to_date,
            half_day: v.half_day || null,
            reason: v.reason || null,
          });
          f.outerHTML = `<p class="callout">Sent for approval: ${r.days} day(s). Follow it under Time off.</p>`;
          notice("Leave request sent for approval.");
        });
      }),
  );
}

async function laxmiAsk(question) {
  const log = document.querySelector("#bot-log");
  log.querySelector(".empty")?.remove();
  log.insertAdjacentHTML(
    "beforeend",
    botMine(question) +
      '<div class="chat-msg bot" id="bot-typing"><small>Laxmi</small><div class="muted">Thinking…</div></div>',
  );
  log.scrollTop = log.scrollHeight;
  try {
    const a = await api("/bot/ask", { question });
    document.querySelector("#bot-typing")?.remove();
    log.insertAdjacentHTML("beforeend", botReply(a));
    botWire(log.lastElementChild);
  } catch (e) {
    document.querySelector("#bot-typing")?.remove();
    log.insertAdjacentHTML(
      "beforeend",
      `<div class="chat-msg bot"><small>Laxmi</small><div class="error-text">${esc(e.message)}</div></div>`,
    );
  }
  log.scrollTop = log.scrollHeight;
}

async function laxmiPage(id) {
  const employee = me.role !== "super_admin";
  const history = employee ? await api("/bot/history") : [];
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Ask Laxmi",
      "Your HR assistant. Answers come from your own records and the company's published guidance. Every question is kept in a log HR can review.",
    ) +
    (employee
      ? `<div class="card bot-card"><div class="chat-msgs bot-log" id="bot-log">${
          history.length
            ? history
                .map(
                  (h) =>
                    botMine(h.question) +
                    botReply({ id: h.id, text: h.answer, helpful: h.helpful }),
                )
                .join("")
            : `<div class="chat-msg bot"><small>Laxmi</small><div>Namaste! I can tell you your leave balance, apply for leave, list holidays, and answer questions about pay, attendance and company policies.</div></div>`
        }</div><div class="actions bot-chips">${BOT_SUGGESTIONS.map((s) => `<button class="secondary chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}</div><form class="chat-send" id="bot-form"><input name="question" maxlength="500" placeholder="Ask about leave, holidays, pay, attendance or a policy" autocomplete="off" required><button>Ask</button></form></div>`
      : "") +
    (has("bot.manage") ? '<div id="bot-admin"></div>' : "");
  const log = document.querySelector("#bot-log");
  if (log) {
    log.scrollTop = log.scrollHeight;
    botWire(log);
    const form = document.querySelector("#bot-form");
    form.onsubmit = (e) => {
      e.preventDefault();
      const q = form.question.value.trim();
      if (!q) return;
      form.question.value = "";
      busy(e.submitter, () => laxmiAsk(q));
    };
    document
      .querySelectorAll("[data-suggest]")
      .forEach((b) => (b.onclick = () => busy(b, () => laxmiAsk(b.dataset.suggest))));
    form.question.focus();
  }
  if (has("bot.manage")) await laxmiAdmin(id);
}

async function laxmiAdmin(id, unansweredOnly = false) {
  const [settings, knowledge, log] = await Promise.all([
    api("/admin/bot/settings"),
    api("/admin/bot/knowledge"),
    api(`/admin/bot/log${unansweredOnly ? "?unanswered=1" : ""}`),
  ]);
  if (id !== renderId) return;
  const s = log.last_30_days;
  document.querySelector("#bot-admin").innerHTML =
    `<div class="stats">${[
      ["Questions, last 30 days", s.questions],
      ["Not answered", s.unanswered],
      ["Marked helpful", s.helpful],
      ["Marked not helpful", s.unhelpful],
    ]
      .map(
        ([l, v]) =>
          `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`,
      )
      .join("")}</div>` +
    `<div class="grid-two"><div class="card"><div class="card-head"><div><h2>Knowledge base</h2><p class="muted">Answers Laxmi gives to common questions. Active policies are searched too.</p></div><button id="kb-add">Add answer</button></div>${
      knowledge.length
        ? knowledge
            .map(
              (k) =>
                `<div class="activity"><strong>${esc(k.title)}</strong>${k.active ? "" : ' <span class="pill neutral">off</span>'}<br><small>${esc(k.body.slice(0, 160))}${k.body.length > 160 ? "…" : ""}${k.keywords ? ` · keywords: ${esc(k.keywords)}` : ""}</small><div class="actions"><button class="ghost" data-kb-edit="${k.id}">Edit</button><button class="ghost" data-kb-toggle="${k.id}">${k.active ? "Turn off" : "Turn on"}</button><button class="ghost" data-kb-delete="${k.id}">Delete</button></div></div>`,
            )
            .join("")
        : empty(
            "No answers yet",
            "Add the questions employees ask HR most often, such as the travel claim process or the dress code.",
          )
    }</div><div class="card"><h2>Settings</h2><form id="bot-settings" class="form-grid"><label class="full">Pay day (day of the month salary is credited)<input name="pay_day" type="number" min="1" max="31" value="${settings.pay_day ?? ""}" placeholder="e.g. 1 or 31"></label><div class="actions full"><button>Save</button></div></form><div class="callout">Free-text answers by Claude: <strong>${settings.ai_fallback ? "on" : "off"}</strong>. ${settings.ai_fallback ? "Questions the rules and knowledge base cannot answer are sent to Claude with only the asking person's own records and matching knowledge-base entries." : "Set ANTHROPIC_API_KEY on the server to turn it on."}</div></div></div>` +
    `<div class="card"><div class="card-head"><div><h2>Questions people asked</h2><p class="muted">The latest 200. Add an answer for anything Laxmi could not handle.</p></div><label class="inline bot-filter"><input type="checkbox" id="bot-unanswered" ${unansweredOnly ? "checked" : ""}> Only unanswered or not helpful</label></div>${
      log.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Employee</th><th>Question</th><th>Answered by</th><th>Feedback</th><th></th></tr></thead><tbody>${log.items
            .map(
              (l) =>
                `<tr><td>${time(l.created_at)}</td><td>${esc(l.employee_name)}<small>${esc(l.employee_code || "")}</small></td><td>${esc(l.question)}</td><td><span class="pill ${l.answered ? "neutral" : ""}">${esc({ rules: "Records", knowledge: "Knowledge base", policy: "Policy", ai: "Claude", none: "Not answered" }[l.source] || l.source)}</span></td><td>${l.helpful === null ? "—" : l.helpful ? "Helpful" : "Not helpful"}</td><td><button class="ghost" data-kb-from="${l.id}">Add answer</button></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("Nothing yet", "Questions appear here as people ask them.")
    }</div>`;
  const kbDialog = (k = {}) =>
    dialog(
      k.id ? "Edit answer" : "Add answer",
      `${input("title", "Question or topic", k.title || "", 'required maxlength="150"')}<label class="full">Answer<textarea name="body" rows="6" maxlength="5000" required>${esc(k.body || "")}</textarea></label>${input("keywords", "Other words people might use (optional)", k.keywords || "", 'maxlength="300" placeholder="e.g. cab, taxi, travel bill"')}`,
      async (f) => {
        if (k.id) await api(`/admin/bot/knowledge/${k.id}`, f, "PATCH");
        else await api("/admin/bot/knowledge", f);
        notice("Saved. Laxmi uses it from the next question.");
      },
    );
  document.querySelector("#kb-add").onclick = () => kbDialog();
  document
    .querySelectorAll("[data-kb-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          kbDialog(knowledge.find((k) => k.id === Number(b.dataset.kbEdit)))),
    );
  document.querySelectorAll("[data-kb-toggle]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const k = knowledge.find((x) => x.id === Number(b.dataset.kbToggle));
          await api(`/admin/bot/knowledge/${k.id}`, { active: !k.active }, "PATCH");
          await laxmiAdmin(renderId, unansweredOnly);
        })),
  );
  document.querySelectorAll("[data-kb-delete]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          if (!confirm("Delete this answer?")) return;
          await api(`/admin/bot/knowledge/${b.dataset.kbDelete}`, undefined, "DELETE");
          await laxmiAdmin(renderId, unansweredOnly);
        })),
  );
  document
    .querySelectorAll("[data-kb-from]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          kbDialog({
            title: log.items.find((l) => l.id === Number(b.dataset.kbFrom))
              .question,
          })),
    );
  document.querySelector("#bot-unanswered").onchange = (e) =>
    laxmiAdmin(renderId, e.target.checked);
  document.querySelector("#bot-settings").onsubmit = (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get("pay_day");
    busy(e.submitter, async () => {
      await api(
        "/admin/bot/settings",
        { pay_day: v === "" ? null : Number(v) },
        "PUT",
      );
      notice("Saved.");
    });
  };
}
