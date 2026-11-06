import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  type Api,
  Btn,
  Field,
  Status,
  attempt,
  dateText,
  errorText,
  k,
  pickAndUpload,
  today,
  useLoad,
} from "./kit";
import { DateField } from "./Daily";
import { Appear, Icon, type IconName, success } from "../ui";
import { T, themed } from "../theme";

// Resigning from the phone, start to finish: the request (why, last day, handover, how to
// reach you after), where it stands step by step, the clearance checklist, the exit interview
// and the settlement. Before HR decides it can be withdrawn at once; after, HR is asked.
type Exit = {
  id: number;
  kind: string;
  status: string;
  notice_given_on: string;
  requested_last_day: string | null;
  last_working_day: string | null;
  reason: string | null;
  reason_category: string | null;
  decision_note: string | null;
  initiated_by: string;
  manager_view: "accept" | "retain" | null;
  manager_at: string | null;
  handover_name: string | null;
  early_release: number;
  withdraw_requested_at: string | null;
  completed_at: string | null;
};
type Mine = {
  exit: Exit | null;
  notice_days: number;
  notice_end?: string;
  days_left?: number | null;
  shortfall?: number;
  clearance?: { id: number; department: string; item: string; cleared: number }[];
  interview?: { submitted_at: string } | null;
  settlement?: { pay_in_month: string; net: number | null } | null;
  reasons: Record<string, string>;
  areas: Record<string, string>;
  questions: Record<string, string>;
};
const plusDays = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

export function ResignationScreen({ api }: { api: Api }) {
  const mine = useLoad(() => api<Mine>("/exit/mine"));
  const m = mine.data;
  const x = m?.exit;
  const live = x && ["pending", "accepted"].includes(x.status);
  return (
    <>
      <Status loading={mine.loading} error={mine.error} />
      {m && live && x && <Progress api={api} m={m} x={x} reload={mine.reload} />}
      {m && !live && (
        <>
          {x && (
            <View style={k.card}>
              <Text style={k.note}>
                Your last resignation ({dateText(x.notice_given_on)}) was {x.status}.
              </Text>
            </View>
          )}
          <ResignForm api={api} m={m} onDone={mine.reload} />
        </>
      )}
    </>
  );
}

// ---- the request ----------------------------------------------------------------------------
function ResignForm({ api, m, onDone }: { api: Api; m: Mine; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [lastDay, setLastDay] = useState("");
  const [cover, setCover] = useState("");
  const [notes, setNotes] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [letter, setLetter] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const noticeEnd = plusDays(today(), m.notice_days);
  const early = !!lastDay && lastDay < noticeEnd;
  const submit = async () => {
    setWorking(true);
    const ok = await attempt(async () => {
      let handover: number | undefined;
      if (cover.trim()) {
        const found = await api<{ id: number; employee_code?: string | null }[]>("/directory?q=" + encodeURIComponent(cover.trim()));
        const p = found.find((f) => (f.employee_code ?? "").toLowerCase() === cover.trim().toLowerCase());
        if (!p) throw new Error("No colleague has employee code " + cover.trim() + ".");
        handover = p.id;
      }
      await api("/exit/resign", {
        reason_category: category,
        reason: reason.trim(),
        requested_last_day: lastDay || undefined,
        handover_to: handover,
        handover_notes: notes.trim() || undefined,
        personal_email: email.trim() || undefined,
        personal_phone: phone.trim() || undefined,
        letter_document_id: letter ?? undefined,
      });
    }, "Your resignation has been sent to your manager and HR.");
    setWorking(false);
    if (ok) {
      success();
      onDone();
    }
  };
  if (!open)
    return (
      <View style={k.card}>
        <Text style={k.heading}>Resignation</Text>
        <Text style={k.body}>
          Your notice period is {m.notice_days} days. If you resign today, it ends on {dateText(noticeEnd)}.
        </Text>
        <Text style={k.note}>
          Your manager gives a view first, then HR confirms your last working day. You can withdraw until HR decides.
        </Text>
        <Btn title="Start resignation" secondary onPress={() => setOpen(true)} />
      </View>
    );
  return (
    <View style={k.card}>
      <Text style={k.heading}>Resignation</Text>
      <Text style={k.label}>Main reason</Text>
      <View style={k.wrap}>
        {Object.entries(m.reasons).map(([v, l]) => (
          <Pressable
            key={v}
            accessibilityRole="radio"
            accessibilityState={{ selected: category === v }}
            onPress={() => setCategory(v)}
            style={[k.chip, category === v && k.chipOn]}
          >
            <Text style={[k.chipText, category === v && { color: "#fff" }]}>{l}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="In your words" value={reason} onChange={setReason} multiline placeholder="A few lines for your manager and HR" />
      <DateField label="Last working day you would like" value={lastDay} onChange={setLastDay} min={today()} />
      <Text style={early ? x.warn : k.note}>
        {lastDay
          ? early
            ? `That is before your notice ends (${dateText(noticeEnd)}): this asks for early release. HR decides; unserved notice may be recovered in your settlement.`
            : "Within your notice period."
          : `Leave it empty to serve the full notice, to ${dateText(noticeEnd)}.`}
      </Text>
      <Field label="Hand over to (colleague's employee code, optional)" value={cover} onChange={setCover} />
      <Field label="Handover notes (optional)" value={notes} onChange={setNotes} multiline placeholder="Open work, files, contacts" />
      <Field label="Personal email, for your relieving letter" value={email} onChange={setEmail} keyboardType="email-address" />
      <Field label="Personal phone (optional)" value={phone} onChange={setPhone} keyboardType="numeric" />
      <Pressable
        accessibilityRole="button"
        style={k.input}
        onPress={async () => {
          try {
            const id = await pickAndUpload(api, "Resignation letter");
            if (id) setLetter(id);
          } catch (e) {
            Alert.alert("Could not attach", errorText(e));
          }
        }}
      >
        <Text style={{ color: letter ? T.ink : T.faint }}>{letter ? "Letter attached" : "Attach a signed letter (optional)"}</Text>
      </Pressable>
      <Btn
        title={working ? "Sending…" : "Submit resignation"}
        disabled={working || !category || !reason.trim()}
        onPress={() =>
          Alert.alert("Submit your resignation?", "Your manager and HR are told straight away.", [
            { text: "Not now", style: "cancel" },
            { text: "Submit", style: "destructive", onPress: () => void submit() },
          ])
        }
      />
      <Btn title="Cancel" secondary onPress={() => setOpen(false)} />
    </View>
  );
}

// ---- where it stands --------------------------------------------------------------------------
function Progress({ api, m, x: e, reload }: { api: Api; m: Mine; x: Exit; reload: () => void }) {
  const cleared = (m.clearance ?? []).filter((c) => c.cleared).length;
  const total = (m.clearance ?? []).length;
  const accepted = e.status === "accepted";
  const steps: [string, string, "done" | "now" | "next", IconName][] = [
    ["Resignation sent", dateText(e.notice_given_on), "done", "paper-plane-outline"],
    [
      "Manager's view",
      e.manager_view ? (e.manager_view === "accept" ? "Agreed" : "Would like you to stay") : "Waiting",
      e.manager_view ? "done" : accepted ? "done" : "now",
      "person-outline",
    ],
    [
      "HR decision",
      accepted ? `Last day ${dateText(e.last_working_day ?? "")}` : "Waiting",
      accepted ? "done" : e.manager_view ? "now" : "next",
      "shield-checkmark-outline",
    ],
    [
      "Notice period",
      accepted ? (m.days_left ? `${m.days_left} day${m.days_left === 1 ? "" : "s"} left` : "Last day") : "",
      accepted ? (m.days_left ? "now" : "done") : "next",
      "hourglass-outline",
    ],
    ["Clearance", total ? `${cleared} of ${total} done` : "", accepted ? (total && cleared === total ? "done" : "now") : "next", "checkbox-outline"],
    ["Exit interview", m.interview ? "Sent, thank you" : accepted ? "Waiting for you" : "", m.interview ? "done" : accepted ? "now" : "next", "chatbox-ellipses-outline"],
    ["Full & final", m.settlement ? `Paid with ${m.settlement.pay_in_month} payroll` : "", m.settlement ? "done" : "next", "wallet-outline"],
  ];
  return (
    <>
      <Appear>
        <View style={[k.card, x.hero]}>
          <Text style={x.heroKicker}>{accepted ? "RESIGNATION ACCEPTED" : "RESIGNATION SENT"}</Text>
          <Text style={x.heroTitle}>
            {accepted
              ? m.days_left
                ? `${m.days_left} day${m.days_left === 1 ? "" : "s"} to your last day`
                : "Today is your last day"
              : "With your manager and HR"}
          </Text>
          <Text style={x.heroSub}>
            {accepted
              ? `Last working day ${dateText(e.last_working_day ?? "")}`
              : `Asked-for last day ${dateText(e.requested_last_day ?? m.notice_end ?? e.notice_given_on)}${e.early_release ? " · early release asked" : ""}`}
          </Text>
          {!!m.shortfall && accepted && (
            <Text style={x.heroSub}>Notice not served: {m.shortfall} days (may be recovered in the settlement)</Text>
          )}
        </View>
      </Appear>
      <Appear index={1}>
        <View style={k.card}>
          {steps.map(([title, note, state, icon], i) => (
            <View key={title} style={x.step}>
              <View style={x.rail}>
                <View style={[x.dot, state === "done" && x.dotDone, state === "now" && x.dotNow]}>
                  <Icon name={state === "done" ? "checkmark" : icon} size={16} color={state === "next" ? T.faint : "#fff"} />
                </View>
                {i < steps.length - 1 && <View style={[x.line, state === "done" && x.lineDone]} />}
              </View>
              <View style={{ flex: 1, paddingBottom: 14 }}>
                <Text style={[k.strong, state === "next" && { color: T.faint }]}>{title}</Text>
                {note ? <Text style={k.note}>{note}</Text> : null}
              </View>
            </View>
          ))}
          {e.decision_note ? <Text style={k.note}>HR: {e.decision_note}</Text> : null}
        </View>
      </Appear>
      {accepted && total > 0 && (
        <Appear index={2}>
          <View style={k.card}>
            <Text style={k.heading}>Clearance</Text>
            {(m.clearance ?? []).map((c) => (
              <View key={c.id} style={k.row}>
                <Icon name={c.cleared ? "checkmark-circle" : "ellipse-outline"} size={20} color={c.cleared ? T.success : T.faint} />
                <View style={{ flex: 1 }}>
                  <Text style={k.strong}>{c.item}</Text>
                  <Text style={k.note}>{c.department}</Text>
                </View>
              </View>
            ))}
          </View>
        </Appear>
      )}
      {accepted && !m.interview && <Interview api={api} m={m} onDone={reload} />}
      <Withdraw api={api} e={e} onDone={reload} />
    </>
  );
}

function Interview({ api, m, onDone }: { api: Api; m: Mine; onDone: () => void }) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [rejoin, setRejoin] = useState<boolean | null>(null);
  const [recommend, setRecommend] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const yesNo = (label: string, v: boolean | null, set: (b: boolean) => void) => (
    <View style={{ gap: 6 }}>
      <Text style={k.label}>{label}</Text>
      <View style={k.wrap}>
        {([true, false] as const).map((b) => (
          <Pressable key={String(b)} onPress={() => set(b)} style={[k.chip, v === b && k.chipOn]} accessibilityRole="radio" accessibilityState={{ selected: v === b }}>
            <Text style={[k.chipText, v === b && { color: "#fff" }]}>{b ? "Yes" : "No"}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
  return (
    <Appear index={3}>
      <View style={k.card}>
        <Text style={k.heading}>Exit interview</Text>
        <Text style={k.note}>Your honest answers help the company improve. HR reads them; your manager does not.</Text>
        {Object.entries(m.areas).map(([key, label]) => (
          <View key={key} style={{ gap: 6 }}>
            <Text style={k.label}>{label}</Text>
            <View style={x.stars} accessibilityRole="adjustable" accessibilityLabel={`${label}: ${ratings[key] ?? "not rated"} of 5`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} hitSlop={6} onPress={() => setRatings({ ...ratings, [key]: n })} accessibilityLabel={`${n} of 5`}>
                  <Icon name={(ratings[key] ?? 0) >= n ? "star" : "star-outline"} size={28} color={(ratings[key] ?? 0) >= n ? "#d49a00" : T.lineStrong} />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
        {Object.entries(m.questions).map(([key, label]) => (
          <Field key={key} label={label} value={answers[key] ?? ""} onChange={(v) => setAnswers({ ...answers, [key]: v })} multiline />
        ))}
        {yesNo("Would you consider working here again?", rejoin, setRejoin)}
        {yesNo("Would you recommend us to a friend?", recommend, setRecommend)}
        <Btn
          title={working ? "Sending…" : "Send exit interview"}
          disabled={working || Object.keys(ratings).length < 3 || !(answers.main_reason ?? "").trim()}
          onPress={async () => {
            setWorking(true);
            const ok = await attempt(
              () => api("/exit/interview", { ratings, answers, would_rejoin: rejoin ?? undefined, would_recommend: recommend ?? undefined }),
              "Thank you for your feedback.",
            );
            setWorking(false);
            if (ok) onDone();
          }}
        />
      </View>
    </Appear>
  );
}

function Withdraw({ api, e, onDone }: { api: Api; e: Exit; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  if (e.initiated_by !== "employee") return null;
  if (e.withdraw_requested_at)
    return (
      <View style={k.card}>
        <Text style={k.note}>You asked to withdraw your resignation on {dateText(e.withdraw_requested_at)}. HR will reply.</Text>
      </View>
    );
  if (e.status === "pending")
    return (
      <Btn
        title="Withdraw resignation"
        secondary
        onPress={() =>
          Alert.alert("Withdraw your resignation?", undefined, [
            { text: "Keep it", style: "cancel" },
            { text: "Withdraw", onPress: () => void attempt(async () => (await api("/exit/withdraw", {}), onDone()), "Your resignation was withdrawn.") },
          ])
        }
      />
    );
  return asking ? (
    <View style={k.card}>
      <Field label="Why would you like to stay?" value={why} onChange={setWhy} multiline />
      <Btn
        title="Ask HR to withdraw it"
        disabled={!why.trim()}
        onPress={() => void attempt(async () => (await api("/exit/withdraw", { reason: why.trim() }), onDone()), "HR has your request.")}
      />
      <Btn title="Cancel" secondary onPress={() => setAsking(false)} />
    </View>
  ) : (
    <Btn title="Ask to withdraw resignation" secondary onPress={() => setAsking(true)} />
  );
}

const x = themed(() =>
  StyleSheet.create({
    warn: { color: T.warning, backgroundColor: T.warningSoft, padding: 10, borderRadius: 10, fontSize: 13 },
    hero: { backgroundColor: T.primaryDark, borderColor: T.primaryDark },
    heroKicker: { color: T.onPrimarySoft, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
    heroTitle: { color: "#fff", fontSize: 24, fontWeight: "800" },
    heroSub: { color: T.onPrimarySoft, fontSize: 14 },
    step: { flexDirection: "row", gap: 12 },
    rail: { alignItems: "center", width: 30 },
    dot: { width: 30, height: 30, borderRadius: 15, backgroundColor: T.fill, alignItems: "center", justifyContent: "center" },
    dotDone: { backgroundColor: T.success },
    dotNow: { backgroundColor: T.primary },
    line: { flex: 1, width: 2, backgroundColor: T.line, marginVertical: 2 },
    lineDone: { backgroundColor: T.success },
    stars: { flexDirection: "row", gap: 6 },
  }),
);
