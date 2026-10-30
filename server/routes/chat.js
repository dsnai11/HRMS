import { HttpError, integer, string } from "../http.js";
import { checkFile } from "./documents.js";
import { can } from "../rbac.js";

const MAX_GROUP = 100;

export function registerChat(router, app) {
  const { db, transaction, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();

  const activePerson = async (companyId, id) => {
    const u = await db
      .prepare(
        "SELECT id,name FROM users WHERE id=? AND company_id=? AND active=1 AND role<>'super_admin'",
      )
      .get(integer(Number(id)), companyId);
    if (!u) throw new HttpError(404, "That person was not found.");
    return u;
  };
  async function membership(user, roomId) {
    const m = await db
      .prepare(
        "SELECT m.*,r.kind,r.name,r.company_id FROM chat_members m JOIN chat_rooms r ON r.id=m.room_id WHERE m.room_id=? AND m.user_id=?",
      )
      .get(integer(Number(roomId)), user.id);
    if (!m || m.company_id !== user.company_id)
      throw new HttpError(404, "Conversation not found.");
    // The HR Team room follows the right: lose it and the room is gone at once.
    if (m.kind === "team" && !can(user, "hrchat.use")) {
      await db
        .prepare("DELETE FROM chat_members WHERE room_id=? AND user_id=?")
        .run(m.room_id, user.id);
      throw new HttpError(404, "Conversation not found.");
    }
    return m;
  }

  // Everyone with the hrchat.use right is in the company's HR Team room; nobody else.
  async function syncTeamRoom(user) {
    if (user.role === "super_admin") return;
    let room = await db
      .prepare("SELECT id FROM chat_rooms WHERE company_id=? AND kind='team'")
      .get(user.company_id);
    if (!can(user, "hrchat.use")) {
      if (room)
        await db
          .prepare("DELETE FROM chat_members WHERE room_id=? AND user_id=?")
          .run(room.id, user.id);
      return;
    }
    if (!room) {
      await db
        .prepare(
          "INSERT INTO chat_rooms(company_id,kind,name,created_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(user.company_id, "team", "HR Team", user.id, nowIso());
      room = await db
        .prepare("SELECT id FROM chat_rooms WHERE company_id=? AND kind='team'")
        .get(user.company_id);
    }
    // A new member starts with the history already read.
    const last = await db
      .prepare("SELECT COALESCE(MAX(id),0) n FROM chat_messages WHERE room_id=?")
      .get(room.id);
    await db
      .prepare(
        "INSERT INTO chat_members(room_id,user_id,last_read_id,joined_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(room.id, user.id, Number(last.n), nowIso());
  }

  // Colleagues to start a conversation with: names and roles only.
  router.get("/api/chat/people", async ({ user, query, send }) => {
    const q = (query.get("q") ?? "").trim().toLowerCase();
    return send(
      200,
      await db
        .prepare(
          `SELECT u.id,u.name,u.employee_code,g.name designation FROM users u LEFT JOIN designations g ON g.id=u.designation_id
           WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' AND u.id<>? ${q ? "AND (lower(u.name) LIKE ? OR lower(u.employee_code) LIKE ?)" : ""}
           ORDER BY u.name LIMIT 30`,
        )
        .all(user.company_id, user.id, ...(q ? [`%${q}%`, `%${q}%`] : [])),
    );
  });

  router.get("/api/chat/rooms", async ({ user, send }) => {
    await syncTeamRoom(user);
    const rooms = await db
      .prepare(
        `SELECT r.id,r.kind,r.name,r.last_message_at,m.last_read_id,
           (SELECT COUNT(*) FROM chat_members x WHERE x.room_id=r.id) members,
           (SELECT COUNT(*) FROM chat_messages c WHERE c.room_id=r.id AND c.id>m.last_read_id AND c.user_id<>? AND c.deleted_at IS NULL) unread,
           (SELECT COALESCE(NULLIF(c.body,''),'📎 File') FROM chat_messages c WHERE c.room_id=r.id AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 1) last_body,
           (SELECT u.name FROM chat_messages c JOIN users u ON u.id=c.user_id WHERE c.room_id=r.id AND c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 1) last_from,
           (SELECT MAX(c.id) FROM chat_messages c WHERE c.room_id=r.id) last_id,
           (SELECT u.name FROM chat_members x JOIN users u ON u.id=x.user_id WHERE x.room_id=r.id AND x.user_id<>? LIMIT 1) other_name
         FROM chat_members m JOIN chat_rooms r ON r.id=m.room_id WHERE m.user_id=? AND r.company_id=?
         ORDER BY COALESCE(r.last_message_at,r.created_at) DESC LIMIT 200`,
      )
      .all(user.id, user.id, user.id, user.company_id);
    return send(
      200,
      rooms.map((r) => ({
        ...r,
        title:
          r.kind === "direct" ? (r.other_name ?? "Former colleague") : r.name,
        last_body: r.last_body?.slice(0, 120) ?? null,
      })),
    );
  });
  router.post("/api/chat/direct", async ({ user, body, send }) => {
    const other = await activePerson(user.company_id, (await body()).user_id);
    if (other.id === user.id) throw new HttpError(400, "Choose someone else.");
    const key = [user.id, other.id].sort((a, b) => a - b).join("-");
    let room = await db
      .prepare("SELECT id FROM chat_rooms WHERE company_id=? AND direct_key=?")
      .get(user.company_id, key);
    if (!room)
      await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO chat_rooms(company_id,kind,direct_key,created_by,created_at) VALUES(?,?,?,?,?)",
              )
              .run(user.company_id, "direct", key, user.id, nowIso())
          ).lastInsertRowid,
        );
        for (const uid of [user.id, other.id])
          await db
            .prepare(
              "INSERT INTO chat_members(room_id,user_id,joined_at) VALUES(?,?,?)",
            )
            .run(id, uid, nowIso());
        room = { id };
      });
    return send(200, { id: room.id });
  });
  // Managers and HR create named group chats; anyone in one can reply.
  router.post("/api/chat/groups", async ({ user, body, send, audit }) => {
    const manages = await db
      .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
      .get(user.id);
    if (!manages && !can(user, "employees.read"))
      throw new HttpError(
        403,
        "Managers and HR can create group chats. Anyone can message a colleague directly.",
      );
    const b = await body();
    const name = string(b.name, "Group name", 60);
    const ids = [
      ...new Set([
        user.id,
        ...(Array.isArray(b.member_ids) ? b.member_ids : []).map((x) =>
          integer(Number(x)),
        ),
      ]),
    ];
    if (ids.length < 2)
      throw new HttpError(400, "Add at least one other person.");
    if (ids.length > MAX_GROUP)
      throw new HttpError(400, `A group can have up to ${MAX_GROUP} people.`);
    for (const id of ids) await activePerson(user.company_id, id);
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO chat_rooms(company_id,kind,name,created_by,created_at) VALUES(?,?,?,?,?)",
            )
            .run(user.company_id, "group", name, user.id, nowIso())
        ).lastInsertRowid,
      );
      for (const uid of ids)
        await db
          .prepare(
            "INSERT INTO chat_members(room_id,user_id,is_admin,joined_at) VALUES(?,?,?,?)",
          )
          .run(id, uid, uid === user.id ? 1 : 0, nowIso());
      await audit("chat_group_created", { id, name, members: ids.length });
      return id;
    });
    return send(201, { id });
  });
  router.get("/api/chat/rooms/:id", async ({ user, params, send }) => {
    const m = await membership(user, params.id);
    return send(200, {
      id: m.room_id,
      kind: m.kind,
      name: m.name,
      is_admin: Boolean(m.is_admin),
      members: await db
        .prepare(
          "SELECT u.id,u.name,x.is_admin,x.last_read_id FROM chat_members x JOIN users u ON u.id=x.user_id WHERE x.room_id=? ORDER BY u.name",
        )
        .all(m.room_id),
    });
  });
  router.post(
    "/api/chat/rooms/:id/members",
    async ({ user, params, body, send, audit }) => {
      const m = await membership(user, params.id);
      if (m.kind === "team")
        throw new HttpError(409, "HR Team members come from the HR team chat right. Change it under Roles & rights.");
      if (m.kind !== "group" || !m.is_admin)
        throw new HttpError(403, "Only the group's admin can add people.");
      const wanted = (await body()).user_ids;
      const ids = [
        ...new Set(
          (Array.isArray(wanted) ? wanted : []).map((x) => integer(Number(x))),
        ),
      ];
      if (!ids.length) throw new HttpError(400, "Choose people to add.");
      const have = (
        await db
          .prepare("SELECT COUNT(*) n FROM chat_members WHERE room_id=?")
          .get(m.room_id)
      ).n;
      if (have + ids.length > MAX_GROUP)
        throw new HttpError(400, `A group can have up to ${MAX_GROUP} people.`);
      for (const id of ids) {
        await activePerson(user.company_id, id);
        await db
          .prepare(
            "INSERT INTO chat_members(room_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
          )
          .run(m.room_id, id, nowIso());
      }
      await audit("chat_members_added", { id: m.room_id, added: ids.length });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/chat/rooms/:id/members/:userId",
    async ({ user, params, send, audit }) => {
      const m = await membership(user, params.id);
      if (m.kind === "team")
        throw new HttpError(409, "HR Team members come from the HR team chat right. Change it under Roles & rights.");
      const target = integer(Number(params.userId));
      if (m.kind !== "group")
        throw new HttpError(409, "You cannot leave a direct conversation.");
      if (target !== user.id && !m.is_admin)
        throw new HttpError(403, "Only the group's admin can remove people.");
      await db
        .prepare("DELETE FROM chat_members WHERE room_id=? AND user_id=?")
        .run(m.room_id, target);
      await audit("chat_member_removed", { id: m.room_id, userId: target });
      return send(200, { ok: true });
    },
  );

  router.get(
    "/api/chat/rooms/:id/messages",
    async ({ user, params, query, send }) => {
      const m = await membership(user, params.id);
      const before = query.get("before")
        ? integer(Number(query.get("before")))
        : null;
      const rows = await db
        .prepare(
          `SELECT c.id,c.user_id,u.name author,c.body,c.created_at,f.id file_id,f.name file_name,f.mime file_mime FROM chat_messages c JOIN users u ON u.id=c.user_id LEFT JOIN chat_files f ON f.message_id=c.id
         WHERE c.room_id=? AND c.deleted_at IS NULL ${before ? "AND c.id<?" : ""} ORDER BY c.id DESC LIMIT 50`,
        )
        .all(m.room_id, ...(before ? [before] : []));
      return send(200, {
        messages: rows.reverse(),
        last_read_id: m.last_read_id,
      });
    },
  );
  router.post(
    "/api/chat/rooms/:id/messages",
    async ({ user, params, body, send }) => {
      const m = await membership(user, params.id);
      rateLimit(`chat:${user.id}`, 300);
      const b = await body(3_000_000);
      // A message is text, a file (PDF, JPG or PNG up to 2 MB), or both.
      const file = b.file ? { ...checkFile(b.file), name: string(b.file.name, "File name", 120) } : null;
      const text =
        typeof b.body === "string" && b.body.trim()
          ? string(b.body, "Message", 2000).trim()
          : file
            ? ""
            : (() => {
                throw new HttpError(400, "Write a message.");
              })();
      const at = nowIso();
      const stored = file ? await app.blobs.put(file.data, "chat") : null;
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO chat_messages(room_id,user_id,body,created_at) VALUES(?,?,?,?)",
              )
              .run(m.room_id, user.id, text, at)
          ).lastInsertRowid,
        );
        if (file)
          await db
            .prepare(
              "INSERT INTO chat_files(message_id,room_id,name,mime,size,data) VALUES(?,?,?,?,?,?)",
            )
            .run(id, m.room_id, file.name, file.mime, file.bytes.length, stored);
        return id;
      });
      await db
        .prepare("UPDATE chat_rooms SET last_message_at=? WHERE id=?")
        .run(at, m.room_id);
      await db
        .prepare(
          "UPDATE chat_members SET last_read_id=? WHERE room_id=? AND user_id=?",
        )
        .run(id, m.room_id, user.id);
      return send(201, { id, created_at: at });
    },
  );
  // Files are for the people in the conversation only.
  router.get("/api/chat/files/:id", async ({ user, params, res, headers }) => {
    const f = await db
      .prepare(
        "SELECT f.*,c.deleted_at FROM chat_files f JOIN chat_messages c ON c.id=f.message_id WHERE f.id=?",
      )
      .get(integer(Number(params.id)));
    if (!f || f.deleted_at) throw new HttpError(404, "File not found.");
    await membership(user, f.room_id);
    res.writeHead(200, {
      ...headers,
      "Content-Type": f.mime,
      "Content-Disposition": `inline; filename="${f.name.replace(/[^A-Za-z0-9._ -]/g, "_")}"`,
      "Cache-Control": "private, no-store",
    });
    res.end(await app.blobs.bytes(f.data));
  });
  router.delete("/api/chat/messages/:id", async ({ user, params, send }) => {
    const c = await db
      .prepare(
        "SELECT c.*,r.company_id FROM chat_messages c JOIN chat_rooms r ON r.id=c.room_id WHERE c.id=?",
      )
      .get(integer(Number(params.id)));
    if (!c || c.company_id !== user.company_id || c.user_id !== user.id)
      throw new HttpError(404, "Message not found.");
    await db
      .prepare("UPDATE chat_messages SET deleted_at=? WHERE id=?")
      .run(nowIso(), c.id);
    return send(200, { ok: true });
  });
  router.post(
    "/api/chat/rooms/:id/read",
    async ({ user, params, body, send }) => {
      const m = await membership(user, params.id);
      const upTo = integer(Number((await body()).message_id));
      await db
        .prepare(
          "UPDATE chat_members SET last_read_id=GREATEST(last_read_id,?) WHERE room_id=? AND user_id=?",
        )
        .run(upTo, m.room_id, user.id);
      return send(200, { ok: true });
    },
  );
  // Polled every few seconds while the portal is open: anything new in my conversations.
  router.get("/api/chat/updates", async ({ user, query, send }) => {
    if (!query.get("since")) await syncTeamRoom(user);
    // The first poll (no "since") only learns where the conversation stands.
    const since = query.get("since") ? Number(query.get("since")) : null;
    if (since !== null && (!Number.isSafeInteger(since) || since < 0))
      throw new HttpError(400, "Invalid identifier.");
    const messages = since === null ? [] : await db
      .prepare(
        `SELECT c.id,c.room_id,c.user_id,u.name author,c.body,c.created_at,r.kind,r.name room_name,f.id file_id,f.name file_name,f.mime file_mime
         FROM chat_messages c JOIN chat_members m ON m.room_id=c.room_id AND m.user_id=? JOIN chat_rooms r ON r.id=c.room_id
         JOIN users u ON u.id=c.user_id LEFT JOIN chat_files f ON f.message_id=c.id
         WHERE c.id>? AND c.deleted_at IS NULL AND r.company_id=? ORDER BY c.id LIMIT 200`,
      )
      .all(user.id, since, user.company_id);
    const latest =
      since === null
        ? ((
            await db
              .prepare(
                "SELECT MAX(c.id) n FROM chat_messages c JOIN chat_members m ON m.room_id=c.room_id AND m.user_id=?",
              )
              .get(user.id)
          ).n ?? 0)
        : (messages.at(-1)?.id ?? since);
    const unread = (
      await db
        .prepare(
          `SELECT COUNT(*) n FROM chat_messages c JOIN chat_members m ON m.room_id=c.room_id AND m.user_id=?
           WHERE c.id>m.last_read_id AND c.user_id<>? AND c.deleted_at IS NULL`,
        )
        .get(user.id, user.id)
    ).n;
    return send(200, {
      messages,
      unread,
      latest,
    });
  });
}
