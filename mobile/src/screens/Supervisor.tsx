import React, { useState } from "react";
import { Text, View } from "react-native";
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
  inr,
  isDate,
  k,
  timeText,
  today,
  useLoad,
} from "./kit";

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
};
const SEP_STATUS: Record<string, string> = {
  pending: "With HR",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
};

/** Approve, or reject with a reason. */
function Decide({
  onDecide,
}: {
  onDecide: (
    decision: "approved" | "rejected",
    note?: string,
  ) => Promise<boolean>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (d: "approved" | "rejected") => {
    if (d === "rejected" && !note.trim()) return;
    setBusy(true);
    await onDecide(d, note.trim() || undefined);
    setBusy(false);
  };
  return rejecting ? (
    <View style={{ gap: 8 }}>
      <Field label="Reason for rejecting" value={note} onChange={setNote} />
      <View style={k.actions}>
        <Btn
          title="Reject"
          onPress={() => void go("rejected")}
          disabled={busy || !note.trim()}
        />
        <Btn title="Back" secondary onPress={() => setRejecting(false)} />
      </View>
    </View>
  ) : (
    <View style={k.actions}>
      <Btn
        title="Approve"
        onPress={() => void go("approved")}
        disabled={busy}
      />
      <Btn
        title="Reject"
        secondary
        onPress={() => setRejecting(true)}
        disabled={busy}
      />
    </View>
  );
}

function Approvals({ api }: { api: Api }) {
  const inbox = useLoad(async () => {
    const [a, od, ot, claims] = await Promise.all([
      api<{ leave: Leave[]; regularizations: Fix[] }>("/approvals"),
      api<Od[]>("/od-visits/pending").catch(() => [] as Od[]),
      api<Ot[]>("/overtime/pending").catch(() => [] as Ot[]),
      api<Claim[]>("/claims/inbox").catch(() => [] as Claim[]),
    ]);
    return { ...a, od, ot, claims };
  });
  const decide =
    (path: string) => (decision: "approved" | "rejected", note?: string) =>
      attempt(async () => {
        await api(path, { decision, note });
        await inbox.reload();
      });
  const d = inbox.data;
  const total = d
    ? d.leave.length +
      d.regularizations.length +
      d.od.length +
      d.ot.length +
      d.claims.length
    : 0;
  return (
    <View style={k.card}>
      <Text style={k.heading}>Waiting for you</Text>
      <Status loading={inbox.loading} error={inbox.error} />
      {d && total === 0 && (
        <Empty text="Nothing is waiting for your approval." />
      )}
      {d?.leave.map((r) => (
        <View key={`l${r.id}`} style={k.item}>
          <Pill text="Leave" />
          <Text style={k.strong}>
            {r.employee_name} · {r.type_name}
          </Text>
          <Text style={k.note}>
            {dateText(r.from_date)}
            {r.to_date !== r.from_date
              ? ` – ${dateText(r.to_date)}`
              : ""} · {r.days} day
            {r.days === 1 ? "" : "s"}
            {r.step_name ? ` · your step: ${r.step_name}` : ""}
          </Text>
          {r.reason ? <Text style={k.body}>{r.reason}</Text> : null}
          <Decide onDecide={decide(`/leave/requests/${r.id}/decision`)} />
        </View>
      ))}
      {d?.regularizations.map((r) => (
        <View key={`r${r.id}`} style={k.item}>
          <Pill text={FIX_KIND[r.kind] ?? r.kind} />
          <Text style={k.strong}>
            {r.employee_name} · {dateText(r.date)}
          </Text>
          {r.in_time || r.out_time ? (
            <Text style={k.note}>
              In {r.in_time ?? "—"} · Out {r.out_time ?? "—"}
            </Text>
          ) : null}
          <Text style={k.body}>{r.reason}</Text>
          <Decide onDecide={decide(`/regularizations/${r.id}/decision`)} />
        </View>
      ))}
      {d?.od.map((r) => (
        <View key={`o${r.id}`} style={k.item}>
          <Pill text="On duty trip" />
          <Text style={k.strong}>{r.employee_name}</Text>
          <Text style={k.note}>
            Out {timeText(r.out_at)}
            {r.in_at ? ` · back ${timeText(r.in_at)}` : ""}
          </Text>
          <Text style={k.body}>{r.purpose}</Text>
          <Decide onDecide={decide(`/od-visits/${r.id}/decision`)} />
        </View>
      ))}
      {d?.ot.map((r) => (
        <View key={`t${r.id}`} style={k.item}>
          <Pill text="Overtime" />
          <Text style={k.strong}>
            {r.employee_name} · {dateText(r.date)}
          </Text>
          <Text style={k.note}>
            {Math.floor(r.minutes_claimed / 60)} h {r.minutes_claimed % 60} min
            claimed
          </Text>
          <Text style={k.body}>{r.reason}</Text>
          <Decide onDecide={decide(`/overtime/${r.id}/decision`)} />
        </View>
      ))}
      {d?.claims.map((r) => (
        <View key={`c${r.id}`} style={k.item}>
          <Pill text="Claim" />
          <Text style={k.strong}>
            {r.employee_name} · {r.type_name} · {inr(r.amount)}
          </Text>
          <Text style={k.note}>{dateText(r.expense_date)}</Text>
          <Text style={k.body}>{r.description}</Text>
          <Decide onDecide={decide(`/claims/${r.id}/decide`)} />
        </View>
      ))}
    </View>
  );
}

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
