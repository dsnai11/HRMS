import React, { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  type Api,
  Btn,
  Choice,
  Empty,
  Field,
  Pill,
  Status,
  Tabs,
  attempt,
  dateText,
  errorText,
  inr,
  isDate,
  k,
  timeText,
  today,
  useLoad,
} from "./kit";
import { T, themed } from "../theme";
import { Icon, tick } from "../ui";

// Supervisor: everything waiting for this person's decision (leave, attendance corrections,
// OD trips, overtime, claims), their team, team resignations and separation. The server
// decides who may act on what; this screen only shows what it returns.
type Leave = {
  id: number;
  employee_name: string;
  type_name: string;
  from_date: string;
  to_date: string;
  days: number;
  reason: string | null;
  step_name?: string;
};
type Fix = {
  id: number;
  employee_name: string;
  date: string;
  kind: string;
  in_time: string | null;
  out_time: string | null;
  reason: string;
  batch_id?: string | null;
};
type Od = {
  id: number;
  employee_name: string;
  purpose: string;
  out_at: string;
  in_at: string | null;
};
type Ot = {
  id: number;
  employee_name: string;
  date: string;
  minutes_claimed: number;
  reason: string;
};
type Claim = {
  id: number;
  employee_name: string;
  type_name: string;
  expense_date: string;
  amount: number;
  description: string;
};
type Member = {
  id: number;
  name: string;
  employee_code: string | null;
  department_name: string | null;
  designation_name: string | null;
  active: number | boolean;
  direct: boolean;
};
type Resignation = {
  id: number;
  employee_name: string;
  status: string;
  notice_given_on: string;
  requested_last_day: string | null;
  reason: string | null;
  manager_view: "accept" | "retain" | null;
  manager_note: string | null;
};
type Away = {
  id: number;
  name: string;
  employee_code: string | null;
  last_seen_on: string | null;
  request_id: number | null;
};
type SepRequest = {
  id: number;
  employee_name: string;
  kind: string;
  status: string;
  created_at: string;
  decision_note: string | null;
};
const FIX_KIND: Record<string, string> = {
  missed_punch: "Missed punch",
  wrong_punch: "Wrong punch",
  on_duty: "On duty",
  work_from_home: "Work from home",
  short_leave: "Short leave",
};
type OptionalChoice = {
  id: number;
  employee_name: string;
  employee_code: string | null;
  date: string;
  name: string;
};
const SEP_STATUS: Record<string, string> = {
  pending: "With HR",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
};

// One list per kind of request. Pending requests can be ticked and decided together: the server
// still checks each one, so a request this person may not decide is reported, not approved.
export type ApprovalKind = "leave" | "regularization" | "od" | "multiple" | "overtime" | "claims" | "optional";
const APPROVAL_LABEL: Record<ApprovalKind, string> = {
  leave: "Leave",
  regularization: "Regularization",
  od: "OD days",
  multiple: "Multiple OD",
  overtime: "Overtime",
  claims: "Claims",
  optional: "Optional holiday",
};
const APPROVAL_ORDER = Object.keys(APPROVAL_LABEL) as ApprovalKind[];
// Kinds with an Approved and Rejected history on the server.
const WITH_HISTORY: ApprovalKind[] = ["leave", "regularization", "od", "multiple"];
// Set just before opening this screen from a Quick Link on Home.
let approvalStart: ApprovalKind | null = null;
export const openApprovalsAt = (kind: ApprovalKind) => {
  approvalStart = kind;
};
const takeApprovalStart = () => {
  const kind = approvalStart;
  approvalStart = null;
  return kind;
};

type ApprovalRow = {
  key: string;
  title: string;
  lines: string[];
  body?: string | null;
  tag?: string;
  paths: string[];
};
const PAGE = 40;
const dayRange = (from: string, to: string) => (to !== from ? `${dateText(from)} – ${dateText(to)}` : dateText(from));
const fixRow = (r: Fix): ApprovalRow => ({
  key: `r${r.id}`,
  title: `${r.employee_name} · ${dateText(r.date)}`,
  tag: FIX_KIND[r.kind] ?? r.kind,
  lines: r.in_time || r.out_time ? [`In ${r.in_time ?? "—"} · Out ${r.out_time ?? "—"}`] : [],
  body: r.reason,
  paths: [`/regularizations/${r.id}/decision`],
});
const batchRow = (rows: Fix[]): ApprovalRow => ({
  key: `b${rows[0].batch_id}`,
  title: `${rows[0].employee_name} · ${dayRange(rows[0].date, rows[rows.length - 1].date)}`,
  tag: `${rows.length} day${rows.length === 1 ? "" : "s"}`,
  lines: [],
  body: rows[0].reason,
  paths: rows.map((x) => `/regularizations/${x.id}/decision`),
});
const leaveRow = (r: Leave): ApprovalRow => ({
  key: `l${r.id}`,
  title: `${r.employee_name} · ${r.type_name}`,
  lines: [`${dayRange(r.from_date, r.to_date)} · ${r.days} day${r.days === 1 ? "" : "s"}${r.step_name ? ` · your step: ${r.step_name}` : ""}`],
  body: r.reason,
  paths: [`/leave/requests/${r.id}/decision`],
});
const odRow = (r: Od): ApprovalRow => ({
  key: `o${r.id}`,
  title: r.employee_name,
  lines: [`Out ${timeText(r.out_at)}${r.in_at ? ` · back ${timeText(r.in_at)}` : ""}`],
  body: r.purpose,
  paths: [`/od-visits/${r.id}/decision`],
});
function splitBatches(rows: Fix[]) {
  const singles: Fix[] = [];
  const batches = new Map<string, Fix[]>();
  for (const f of rows)
    if (f.batch_id) batches.set(f.batch_id, [...(batches.get(f.batch_id) ?? []), f]);
    else singles.push(f);
  return { singles, batches: [...batches.values()] };
}

function Approvals({ api }: { api: Api }) {
  const [chosen, setChosen] = useState<ApprovalKind | null>(takeApprovalStart);
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const inbox = useLoad(async () => {
    const [a, od, ot, claims, optional] = await Promise.all([
      api<{ leave: Leave[]; regularizations: Fix[] }>("/approvals"),
      api<Od[]>("/od-visits/pending").catch(() => [] as Od[]),
      api<Ot[]>("/overtime/pending").catch(() => [] as Ot[]),
      api<Claim[]>("/claims/inbox").catch(() => [] as Claim[]),
      api<OptionalChoice[]>("/optional-holidays/inbox").catch(() => [] as OptionalChoice[]),
    ]);
    const { singles, batches } = splitBatches(a.regularizations);
    const lists: Record<ApprovalKind, ApprovalRow[]> = {
      leave: a.leave.map(leaveRow),
      regularization: singles.map(fixRow),
      od: od.map(odRow),
      multiple: batches.map(batchRow),
      overtime: ot.map((r) => ({
        key: `t${r.id}`,
        title: `${r.employee_name} · ${dateText(r.date)}`,
        lines: [`${Math.floor(r.minutes_claimed / 60)} h ${r.minutes_claimed % 60} min claimed`],
        body: r.reason,
        paths: [`/overtime/${r.id}/decision`],
      })),
      claims: claims.map((r) => ({
        key: `c${r.id}`,
        title: `${r.employee_name} · ${r.type_name} · ${inr(r.amount)}`,
        lines: [dateText(r.expense_date)],
        body: r.description,
        paths: [`/claims/${r.id}/decide`],
      })),
      optional: optional.map((r) => ({
        key: `h${r.id}`,
        title: `${r.employee_name} · ${r.name}`,
        lines: [dateText(r.date)],
        paths: [`/optional-holidays/${r.id}/decision`],
      })),
    };
    return lists;
  });
  const [history, setHistory] = useState<Partial<Record<ApprovalKind, ApprovalRow[]>> | null>(null);
  const [historyError, setHistoryError] = useState("");
  useEffect(() => {
    if (status === "pending") return;
    let stale = false;
    const load = async () => {
      setHistory(null);
      setHistoryError("");
      try {
        const h = await api<{ leave: Leave[]; regularizations: Fix[]; od: Od[] }>(`/approvals/decided?status=${status}`);
        if (stale) return;
        const { singles, batches } = splitBatches(h.regularizations);
        setHistory({
          leave: h.leave.map(leaveRow),
          regularization: singles.map(fixRow),
          od: h.od.map(odRow),
          multiple: batches.map(batchRow),
        });
      } catch (e) {
        if (!stale) setHistoryError(errorText(e));
      }
    };
    // Asks the server when the status changes; state is set after it answers.
    void load();
    return () => {
      stale = true;
    };
  }, [api, status]);
  const lists = inbox.data;
  const count = (x: ApprovalKind) => lists?.[x].length ?? 0;
  const kind: ApprovalKind = chosen ?? APPROVAL_ORDER.find((x) => count(x) > 0) ?? "leave";
  const pendingView = status === "pending";
  const rows = pendingView ? (lists?.[kind] ?? []) : (history?.[kind] ?? []);
  const visible = rows.slice(0, shown);
  const chosenRows = rows.filter((r) => picked.has(r.key));
  const allPicked = rows.length > 0 && chosenRows.length === rows.length;
  const reset = () => {
    setPicked(new Set());
    setShown(PAGE);
    setRejecting(false);
    setNote("");
    setResult("");
  };
  const toggle = (key: string) => {
    tick();
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const run = async (decision: "approved" | "rejected", reason?: string) => {
    setBusy(true);
    setResult("");
    const queue = [...chosenRows];
    let done = 0;
    let failed = 0;
    let firstError = "";
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          for (const path of job.paths) await api(path, { decision, note: reason });
          done++;
        } catch (e) {
          failed++;
          firstError ||= errorText(e);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setPicked(new Set());
    setRejecting(false);
    setNote("");
    setResult(
      `${done} ${decision}.${failed ? ` ${failed} could not be saved: ${firstError}` : ""}`,
    );
    await inbox.reload();
    setBusy(false);
  };
  const approve = () => {
    if (chosenRows.length === 1) return void run("approved");
    Alert.alert(`Approve ${chosenRows.length} requests?`, "Each selected request will be approved.", [
      { text: "Cancel", style: "cancel" },
      { text: "Approve", onPress: () => void run("approved") },
    ]);
  };
  const loading = pendingView ? inbox.loading : !history && !historyError;
  const error = pendingView ? inbox.error : historyError;
  return (
    <View style={k.card}>
      <Text style={k.heading}>Waiting for you</Text>
      <Choice<ApprovalKind>
        options={APPROVAL_ORDER.filter((x) => WITH_HISTORY.includes(x) || count(x) > 0).map(
          (x) => [x, count(x) ? `${APPROVAL_LABEL[x]} (${count(x)})` : APPROVAL_LABEL[x]],
        )}
        value={kind}
        onChange={(v) => {
          setChosen(v);
          if (!WITH_HISTORY.includes(v)) setStatus("pending");
          reset();
        }}
      />
      {WITH_HISTORY.includes(kind) && (
        <Choice<"pending" | "approved" | "rejected">
          options={[["pending", "Pending"], ["approved", "Approved by me"], ["rejected", "Rejected by me"]]}
          value={status}
          onChange={(v) => {
            setStatus(v);
            reset();
          }}
        />
      )}
      <Status loading={loading} error={error} />
      {!!result && <Text style={k.note}>{result}</Text>}
      {pendingView && rows.length > 0 && (
        <View style={a.bar}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allPicked }}
            accessibilityLabel="Select all"
            style={a.allRow}
            onPress={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.key)))}
          >
            <Icon name={allPicked ? "checkbox" : "square-outline"} size={24} color={T.primaryText} />
            <Text style={k.strong}>All ({rows.length})</Text>
          </Pressable>
          <Text style={k.note}>{chosenRows.length ? `${chosenRows.length} selected` : "Select requests to act"}</Text>
          {rejecting ? (
            <View style={{ gap: 8, width: "100%" }}>
              <Field label="Reason for rejecting" value={note} onChange={setNote} />
              <View style={k.actions}>
                <Btn title="Reject" onPress={() => void run("rejected", note.trim())} disabled={busy || !note.trim() || !chosenRows.length} />
                <Btn title="Back" secondary onPress={() => setRejecting(false)} />
              </View>
            </View>
          ) : (
            <View style={[k.actions, { width: "100%" }]}>
              <Btn title={busy ? "Saving…" : "Approve"} onPress={approve} disabled={busy || !chosenRows.length} />
              <Btn title="Reject" secondary onPress={() => setRejecting(true)} disabled={busy || !chosenRows.length} />
            </View>
          )}
        </View>
      )}
      {!loading && rows.length === 0 && (
        <Empty text={pendingView ? `Nothing is waiting for you under ${APPROVAL_LABEL[kind]}.` : "Nothing here yet."} />
      )}
      {visible.map((r) => {
        const on = picked.has(r.key);
        const inner = (
          <>
            <View style={{ flex: 1, gap: 4 }}>
              {r.tag ? <Pill text={r.tag} /> : null}
              <Text style={k.strong}>{r.title}</Text>
              {r.lines.map((l) => (
                <Text key={l} style={k.note}>{l}</Text>
              ))}
              {r.body ? <Text style={k.body}>{r.body}</Text> : null}
            </View>
            {pendingView && <Icon name={on ? "checkbox" : "square-outline"} size={24} color={on ? T.primaryText : T.muted} />}
          </>
        );
        return pendingView ? (
          <Pressable
            key={r.key}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={r.title}
            style={[k.item, a.row]}
            onPress={() => toggle(r.key)}
          >
            {inner}
          </Pressable>
        ) : (
          <View key={r.key} style={[k.item, a.row]}>{inner}</View>
        );
      })}
      {rows.length > shown && <Btn title={`Show more (${rows.length - shown} left)`} secondary onPress={() => setShown(shown + PAGE)} />}
    </View>
  );
}
const a = themed(() =>
  StyleSheet.create({
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: T.fill },
    allRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  }),
);

function Team({ api }: { api: Api }) {
  const team = useLoad(() => api<Member[]>("/team/members"));
  return (
    <View style={k.card}>
      <Text style={k.heading}>My team</Text>
      <Status loading={team.loading} error={team.error} />
      {team.data?.length === 0 && <Empty text="No one reports to you." />}
      {team.data?.map((m) => (
        <View key={m.id} style={k.row}>
          <View style={{ flex: 1 }}>
            <Text style={k.strong}>{m.name}</Text>
            <Text style={k.note}>
              {[m.employee_code, m.designation_name, m.department_name]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <Pill text={m.direct ? "Direct" : "Indirect"} />
        </View>
      ))}
    </View>
  );
}

function Resignations({ api }: { api: Api }) {
  const list = useLoad(() => api<Resignation[]>("/team/resignations"));
  const [open, setOpen] = useState<number | null>(null);
  const [view, setView] = useState<"accept" | "retain">("accept");
  const [note, setNote] = useState("");
  const [lastDay, setLastDay] = useState("");
  return (
    <View style={k.card}>
      <Text style={k.heading}>Resignations in my team</Text>
      <Text style={k.note}>
        Tell HR whether to accept or try to keep the person. HR decides.
      </Text>
      <Status loading={list.loading} error={list.error} />
      {list.data?.length === 0 && (
        <Empty text="No resignations in the last six months." />
      )}
      {list.data?.map((x) => (
        <View key={x.id} style={k.item}>
          <Text style={k.strong}>{x.employee_name}</Text>
          <Text style={k.note}>
            Resigned {dateText(x.notice_given_on)}
            {x.requested_last_day
              ? ` · asked to leave ${dateText(x.requested_last_day)}`
              : ""}
          </Text>
          {x.reason ? <Text style={k.body}>{x.reason}</Text> : null}
          {x.manager_view ? (
            <Text style={k.note}>
              Your view:{" "}
              {x.manager_view === "accept" ? "Accept" : "Try to retain"}
              {x.manager_note ? ` · ${x.manager_note}` : ""}
            </Text>
          ) : null}
          {x.status !== "pending" ? (
            <Pill
              text={x.status === "accepted" ? "Accepted by HR" : x.status}
            />
          ) : open === x.id ? (
            <View style={{ gap: 8 }}>
              <Choice
                options={[
                  ["accept", "Accept"],
                  ["retain", "Try to retain"],
                ]}
                value={view}
                onChange={setView}
              />
              <Field
                label="Suggested last day (YYYY-MM-DD, optional)"
                value={lastDay}
                onChange={setLastDay}
              />
              <Field
                label="Note for HR (needed to retain)"
                value={note}
                onChange={setNote}
                multiline
              />
              <View style={k.actions}>
                <Btn
                  title="Send to HR"
                  onPress={() =>
                    void attempt(async () => {
                      if (lastDay && !isDate(lastDay))
                        throw new Error("Write the date as YYYY-MM-DD.");
                      await api(`/team/resignations/${x.id}/review`, {
                        view,
                        note: note.trim() || undefined,
                        last_day: lastDay.trim() || undefined,
                      });
                      setOpen(null);
                      await list.reload();
                    }, "Your view was sent to HR.")
                  }
                />
                <Btn title="Cancel" secondary onPress={() => setOpen(null)} />
              </View>
            </View>
          ) : (
            <Btn
              title={x.manager_view ? "Change your view" : "Give your view"}
              secondary
              onPress={() => {
                setOpen(x.id);
                setView(x.manager_view ?? "accept");
                setNote(x.manager_note ?? "");
                setLastDay("");
              }}
            />
          )}
        </View>
      ))}
    </View>
  );
}

function Separation({ api }: { api: Api }) {
  const data = useLoad(async () => {
    const [away, requests, team] = await Promise.all([
      api<{ days: number; items: Away[] }>("/team/absconding"),
      api<SepRequest[]>("/team/separations"),
      api<Member[]>("/team/members"),
    ]);
    return { away, requests, team: team.filter((m) => m.active) };
  });
  const [asking, setAsking] = useState<{
    userId: number | null;
    seen: string;
  } | null>(null);
  const [kind, setKind] = useState<"termination" | "absconding">("termination");
  const [reason, setReason] = useState("");
  const [lastSeen, setLastSeen] = useState("");
  const startAsk = (userId: number | null, seen: string) => {
    setAsking({ userId, seen });
    setKind(seen ? "absconding" : "termination");
    setLastSeen(seen);
    setReason("");
  };
  if (asking && data.data)
    return (
      <View style={k.card}>
        <Text style={k.heading}>Ask HR to separate</Text>
        <Choice
          label="Employee"
          options={data.data.team.map(
            (m) => [m.id, m.name] as [number, string],
          )}
          value={asking.userId}
          onChange={(v) => setAsking({ ...asking, userId: v })}
        />
        <Choice
          label="Type"
          options={[
            ["termination", "Termination"],
            ["absconding", "Absconding"],
          ]}
          value={kind}
          onChange={setKind}
        />
        <Field
          label={`Last day at work (YYYY-MM-DD${kind === "absconding" ? ", needed" : ", optional"})`}
          value={lastSeen}
          onChange={setLastSeen}
        />
        <Field
          label="Reason and what has been tried (calls, warnings, notices)"
          value={reason}
          onChange={setReason}
          multiline
        />
        <View style={k.actions}>
          <Btn
            title="Send to HR"
            disabled={!asking.userId || !reason.trim()}
            onPress={() =>
              void attempt(async () => {
                if (lastSeen && (!isDate(lastSeen) || lastSeen > today()))
                  throw new Error("Write a past date as YYYY-MM-DD.");
                await api("/team/separations", {
                  user_id: asking.userId,
                  kind,
                  reason: reason.trim(),
                  last_seen_on: lastSeen.trim() || undefined,
                });
                setAsking(null);
                await data.reload();
              }, "Sent to HR.")
            }
          />
          <Btn title="Cancel" secondary onPress={() => setAsking(null)} />
        </View>
      </View>
    );
  return (
    <>
      <View style={k.card}>
        <Text style={k.heading}>Not coming to work</Text>
        <Text style={k.note}>
          Team members with no punch-in and no approved leave for{" "}
          {data.data?.away.days ?? 7} days. Weekly offs and holidays are
          counted, so check before acting.
        </Text>
        <Status loading={data.loading} error={data.error} />
        {data.data?.away.items.length === 0 && (
          <Empty text="Everyone is accounted for." />
        )}
        {data.data?.away.items.map((p) => (
          <View key={p.id} style={k.row}>
            <View style={{ flex: 1 }}>
              <Text style={k.strong}>{p.name}</Text>
              <Text style={k.note}>
                Last punch-in:{" "}
                {p.last_seen_on ? dateText(p.last_seen_on) : "never"}
              </Text>
            </View>
            {p.request_id ? (
              <Pill text="With HR" />
            ) : (
              <Btn
                title="Ask HR"
                secondary
                onPress={() => startAsk(p.id, p.last_seen_on ?? "")}
              />
            )}
          </View>
        ))}
      </View>
      <View style={k.card}>
        <Text style={k.heading}>My separation requests</Text>
        {data.data?.requests.length === 0 && (
          <Empty text="You have not raised any requests." />
        )}
        {data.data?.requests.map((r) => (
          <View key={r.id} style={k.item}>
            <Text style={k.strong}>
              {r.employee_name} ·{" "}
              {r.kind === "absconding" ? "Absconding" : "Termination"}
            </Text>
            <Text style={k.note}>
              {dateText(r.created_at)} · {SEP_STATUS[r.status]}
              {r.decision_note ? ` · ${r.decision_note}` : ""}
            </Text>
            {r.status === "pending" && (
              <Btn
                title="Cancel request"
                secondary
                onPress={() =>
                  void attempt(async () => {
                    await api(`/team/separations/${r.id}/cancel`, {});
                    await data.reload();
                  })
                }
              />
            )}
          </View>
        ))}
        <Btn
          title="Ask HR to separate someone"
          onPress={() => startAsk(null, "")}
          disabled={!data.data?.team.length}
        />
      </View>
    </>
  );
}

type Tab = "approvals" | "team" | "resignations" | "separation";
export function SupervisorScreen({ api }: { api: Api }) {
  const [tab, setTab] = useState<Tab>("approvals");
  return (
    <View style={{ gap: 14 }}>
      <Tabs
        tabs={[
          ["approvals", "Approvals"],
          ["team", "My team"],
          ["resignations", "Resignations"],
          ["separation", "Separation"],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "approvals" && <Approvals api={api} />}
      {tab === "team" && <Team api={api} />}
      {tab === "resignations" && <Resignations api={api} />}
      {tab === "separation" && <Separation api={api} />}
    </View>
  );
}
