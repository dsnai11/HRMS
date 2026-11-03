import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  type Api,
  Btn,
  Field,
  Status,
  attempt,
  errorText,
  pickAndUpload,
  today,
  useLoad,
} from "./kit";

// The day-to-day screens of the phone app: attendance log and summary, regularization,
// Multiple OD, leave (summary, request, history), holidays and optional holidays. The
// layout follows the screens staff knew from the old HR app; the look is Laxmi's own.

export const C = {
  red: "#c8102e",
  dark: "#ac051b",
  soft: "#fde7ea",
  ink: "#2a2c3a",
  muted: "#6b6e7c",
  line: "#eceaf1",
  page: "#f8f7fa",
  green: "#1f7a4d",
  greenSoft: "#e3f4ea",
  amber: "#8a5300",
  amberSoft: "#fff1d6",
  blue: "#1d5fbf",
  blueSoft: "#e7effc",
  violet: "#5b3fa6",
  violetSoft: "#efeafb",
};
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "grey";
const TONE: Record<Tone, [string, string]> = {
  green: [C.green, C.greenSoft],
  amber: [C.amber, C.amberSoft],
  red: [C.dark, C.soft],
  blue: [C.blue, C.blueSoft],
  violet: [C.violet, C.violetSoft],
  grey: [C.muted, "#f0eff4"],
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const parts = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return { y, m, day, wd: new Date(Date.UTC(y, m - 1, day)).getUTCDay() };
};
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const hhmm = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))
    : "N/A";
const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const shiftMonth = (key: string, by: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
};
const daysUntil = (d: string) =>
  Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(today() + "T00:00:00Z")) / 86400000);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---- small pieces -----------------------------------------------------------------------------
export function Tag({ text, tone = "grey" }: { text: string; tone?: Tone }) {
  const [fg, bg] = TONE[tone];
  return (
    <View style={[d.tag, { backgroundColor: bg }]}>
      <Text style={[d.tagText, { color: fg }]}>{text}</Text>
    </View>
  );
}
// The coloured date block on the left of a card.
function DateBlock({ date, extra }: { date: string; extra?: string }) {
  const p = parts(date);
  return (
    <View style={d.dateBlock}>
      <Text style={d.dateDay}>{p.day}</Text>
      <Text style={d.dateSub}>{WEEKDAYS[p.wd]}</Text>
      <Text style={d.dateSmall}>{extra ?? `${String(p.m).padStart(2, "0")}/${p.y}`}</Text>
    </View>
  );
}
function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={d.segments} accessibilityRole="tablist">
      {options.map(([v, l]) => (
        <Pressable
          key={v}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === v }}
          onPress={() => onChange(v)}
          style={[d.segment, value === v && d.segmentOn]}
        >
          <Text style={[d.segmentText, value === v && { color: "#fff" }]} numberOfLines={1}>
            {l}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
function Meter({ pct, color = C.red }: { pct: number; color?: string }) {
  return (
    <View style={d.meter} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <View style={[d.meterFill, { width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: color }]} />
    </View>
  );
}
// A round figure for a percentage (a full ring needs drawing; this keeps to plain views).
function Ring({ pct, label }: { pct: number; label: string }) {
  return (
    <View style={d.ring} accessibilityLabel={`${Math.round(pct)}% ${label}`}>
      <Text style={d.ringValue}>{Math.round(pct)}%</Text>
      <Text style={d.ringLabel}>{label}</Text>
    </View>
  );
}
function MonthPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const [y, m] = value.split("-").map(Number);
  const now = today().slice(0, 7);
  return (
    <View style={d.monthBar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={10} onPress={() => onChange(shiftMonth(value, -1))}>
        <Text style={d.monthArrow}>‹</Text>
      </Pressable>
      <Text style={d.monthText}>
        {MONTHS_LONG[m - 1]} {y}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next month"
        hitSlop={10}
        disabled={value >= now}
        onPress={() => onChange(shiftMonth(value, 1))}
      >
        <Text style={[d.monthArrow, value >= now && { opacity: 0.3 }]}>›</Text>
      </Pressable>
    </View>
  );
}
// A date chosen from a month calendar, so nobody has to type 2026-11-03.
export function DateField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((value || today()).slice(0, 7));
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array(first).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <Text style={d.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? dmy(value) : "not chosen"}`}
        style={d.input}
        onPress={() => {
          setMonth((value || today()).slice(0, 7));
          setOpen(true);
        }}
      >
        <Text style={{ color: value ? C.ink : "#9a9cab", fontSize: 15 }}>{value ? dmy(value) : "Tap to select"}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={d.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={d.calendar} onPress={() => {}}>
            <View style={d.monthBar}>
              <Pressable hitSlop={10} accessibilityLabel="Previous month" onPress={() => setMonth(shiftMonth(month, -1))}>
                <Text style={d.monthArrow}>‹</Text>
              </Pressable>
              <Text style={d.monthText}>
                {MONTHS_LONG[m - 1]} {y}
              </Text>
              <Pressable hitSlop={10} accessibilityLabel="Next month" onPress={() => setMonth(shiftMonth(month, 1))}>
                <Text style={d.monthArrow}>›</Text>
              </Pressable>
            </View>
            <View style={d.calGrid}>
              {WEEKDAYS.map((w) => (
                <Text key={w} style={d.calHead}>
                  {w.slice(0, 2)}
                </Text>
              ))}
              {cells.map((c, i) => {
                const off = !c || (min && c < min) || (max && c > max);
                return (
                  <Pressable
                    key={i}
                    disabled={!!off}
                    accessibilityRole="button"
                    accessibilityLabel={c ? dmy(c) : undefined}
                    onPress={() => {
                      if (!c) return;
                      onChange(c);
                      setOpen(false);
                    }}
                    style={[d.calCell, c === value && d.calOn]}
                  >
                    <Text style={[d.calText, off && { opacity: 0.25 }, c === value && { color: "#fff" }]}>
                      {c ? Number(c.slice(8)) : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Btn title="Close" secondary onPress={() => setOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <Text style={d.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={d.input}
        value={value}
        placeholder="09:30"
        placeholderTextColor="#9a9cab"
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        onChangeText={(t) => {
          const digits = t.replace(/\D/g, "").slice(0, 4);
          onChange(digits.length > 2 ? digits.slice(0, 2) + ":" + digits.slice(2) : digits);
        }}
      />
    </View>
  );
}
// A form that slides up from the bottom.
function Sheet({
  visible,
  title,
  sub,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={d.sheetWrap}>
        <View style={d.sheet}>
          <View style={d.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={d.sheetTitle}>{title}</Text>
              {sub ? <Text style={d.note}>{sub}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={d.close}>
              <Text style={{ fontSize: 18, color: C.muted }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[d.card, style]}>{children}</View>;
}
function EmptyCard({ title, text }: { title: string; text: string }) {
  return (
    <Card style={{ alignItems: "center", paddingVertical: 30 }}>
      <View style={d.emptyIcon}>
        <Text style={{ fontSize: 22, color: C.red }}>◎</Text>
      </View>
      <Text style={d.strong}>{title}</Text>
      <Text style={[d.note, { textAlign: "center" }]}>{text}</Text>
    </Card>
  );
}

// ---- attendance log -----------------------------------------------------------------------------
type CalendarDay = {
  date: string;
  status: string;
  present?: number;
  leave?: number;
  source?: string | null;
  in_at?: string | null;
  out_at?: string | null;
  holiday?: string | null;
};
type Calendar = {
  month: string;
  days: CalendarDay[];
  present?: number;
  half_days?: number;
  leave_paid?: number;
  leave_unpaid?: number;
  holidays?: number;
  weekly_offs?: number;
  absent?: number;
  payable_days?: number;
};
const DAY_CODE: Record<string, [string, Tone, string]> = {
  present: ["P", "green", "Present"],
  half_day: ["HD", "amber", "Half day"],
  absent: ["A", "red", "Absent"],
  leave: ["L", "blue", "On leave"],
  half_leave: ["½L", "blue", "Half-day leave"],
  half_day_and_leave: ["HD/L", "blue", "Half day and leave"],
  holiday: ["H", "violet", "Holiday"],
  weekly_off: ["WO", "grey", "Weekly off"],
  pending: ["NA", "amber", "Not yet marked"],
};
const SOURCE: Record<string, string> = {
  punch: "Mobile",
  od_punch: "OD punch",
  on_duty: "On duty",
  work_from_home: "Work from home",
  short_leave: "Short leave",
  regularized: "Regularized",
  od_rejected: "OD rejected",
  import: "Imported",
};
const SHOWN = (s: string) => !["future", "not_started", "not_joined", "exited"].includes(s);

// The person's month, day by day; reloads when the month changes.
function useMonth(api: Api) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [loaded, setLoaded] = useState<{ month: string; data: Calendar } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    async (m: string) => {
      setError("");
      try {
        setLoaded({ month: m, data: await api<Calendar>("/attendance/calendar?month=" + m) });
      } catch (e) {
        setError(errorText(e));
      }
    },
    [api],
  );
  useEffect(() => {
    // Loads the chosen month; state is set after the request returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(month);
  }, [load, month]);
  return { month, setMonth, error, data: loaded?.month === month ? loaded.data : null, reload: () => load(month) };
}

export function AttLogScreen({ api }: { api: Api }) {
  const { month, setMonth, error, data: loaded, reload } = useMonth(api);
  const [fixDate, setFixDate] = useState<string | null>(null);
  const days = (loaded?.days ?? []).filter((x) => SHOWN(x.status)).reverse();
  return (
    <>
      <MonthPicker value={month} onChange={setMonth} />
      {error ? <Text style={d.error}>{error}</Text> : null}
      {!loaded && !error && <Status loading error="" />}
      {loaded && days.length === 0 && (
        <EmptyCard title="Nothing to show" text="Days appear here once attendance counts for this month." />
      )}
      {days.map((x) => {
        const [code, tone, word] = DAY_CODE[x.status] ?? ["—", "grey" as Tone, x.status];
        const fixable = ["absent", "half_day", "half_leave", "pending"].includes(x.status) || (!!x.in_at && !x.out_at && x.date < today());
        return (
          <View key={x.date} style={d.logCard}>
            <DateBlock date={x.date} />
            <View style={[d.logBar, { backgroundColor: TONE[tone][0] }]} />
            <View style={d.logBody}>
              <View style={d.rowBetween}>
                <Text style={d.timeLine}>
                  In <Text style={d.timeIn}>{hhmm(x.in_at ?? null)}</Text>
                </Text>
                <Text style={d.timeLine}>
                  Out <Text style={d.timeOut}>{hhmm(x.out_at ?? null)}</Text>
                </Text>
              </View>
              <View style={d.rowBetween}>
                <Text style={d.note}>
                  {x.holiday ? x.holiday : x.source ? "Source: " + (SOURCE[x.source] ?? x.source) : word}
                </Text>
                <View accessibilityLabel={word}>
                  <Tag text={code} tone={tone} />
                </View>
              </View>
              {fixable && (
                <Pressable accessibilityRole="button" style={d.smallBtn} onPress={() => setFixDate(x.date)}>
                  <Text style={d.smallBtnText}>✎ Regularize</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
      <RequestSheet
        api={api}
        date={fixDate}
        onClose={() => setFixDate(null)}
        onDone={() => {
          setFixDate(null);
          void reload();
        }}
      />
    </>
  );
}

// ---- regularization -----------------------------------------------------------------------------
type Correction = {
  id: number;
  date: string;
  kind: string;
  status: string;
  reason: string;
  in_time: string | null;
  out_time: string | null;
  batch_id?: string | null;
  decision_note?: string | null;
  from_punch?: number | boolean;
};
const KINDS: [string, string][] = [
  ["missed_punch", "Present (missed or wrong punch)"],
  ["on_duty", "Outdoor duty"],
  ["work_from_home", "Work from home"],
  ["short_leave", "Short leave"],
];
const KIND_LABEL: Record<string, string> = {
  missed_punch: "Present",
  wrong_punch: "Present",
  on_duty: "Outdoor duty",
  work_from_home: "Work from home",
  short_leave: "Short leave",
};
const STATUS_TONE: Record<string, Tone> = { pending: "amber", approved: "green", rejected: "red", cancelled: "grey" };
const STATUS_WORD: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Withdrawn" };

function RequestSheet({
  api,
  date,
  visible,
  onClose,
  onDone,
}: {
  api: Api;
  date: string | null;
  visible?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = visible ?? date !== null;
  const [kind, setKind] = useState("missed_punch");
  const [day, setDay] = useState("");
  const [inTime, setIn] = useState(""),
    [outTime, setOut] = useState(""),
    [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  // A new date from the attendance log starts a fresh form.
  if (open && (date ?? "") !== seen) {
    setSeen(date ?? "");
    setDay(date ?? "");
    setIn("");
    setOut("");
    setReason("");
  }
  const needsTimes = kind === "missed_punch" || kind === "short_leave";
  return (
    <Sheet visible={open} title="Request regularization" sub="Give the attendance details to correct." onClose={onClose}>
      <Text style={d.label}>Type</Text>
      <View style={d.wrap}>
        {KINDS.map(([v, l]) => (
          <Pressable
            key={v}
            accessibilityRole="radio"
            accessibilityState={{ selected: kind === v }}
            onPress={() => setKind(v)}
            style={[d.chip, kind === v && d.chipOn]}
          >
            <Text style={[d.chipText, kind === v && { color: "#fff" }]}>{l}</Text>
          </Pressable>
        ))}
      </View>
      {kind === "short_leave" && (
        <Text style={d.note}>Short leave: give the times you actually worked. Once approved, the day counts in full.</Text>
      )}
      <DateField label="Attendance date" value={day} onChange={setDay} max={today()} />
      <View style={d.row2}>
        <TimeField label={needsTimes ? "Time in" : "Time in (optional)"} value={inTime} onChange={setIn} />
        <TimeField label={needsTimes ? "Time out" : "Time out (optional)"} value={outTime} onChange={setOut} />
      </View>
      <Field label="Reason" value={reason} onChange={setReason} multiline placeholder="Briefly say why" />
      <Btn
        title={working ? "Sending…" : "Submit request"}
        disabled={working || !day || !reason.trim() || (needsTimes && (inTime.length < 5 || outTime.length < 5))}
        onPress={async () => {
          setWorking(true);
          const ok = await attempt(
            () =>
              api("/regularizations", {
                kind,
                date: day,
                in_time: inTime || undefined,
                out_time: outTime || undefined,
                reason: reason.trim(),
              }),
            "Request sent for approval.",
          );
          setWorking(false);
          if (ok) {
            setSeen(null);
            onDone();
          }
        }}
      />
    </Sheet>
  );
}

export function RegularizationScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Correction[]>("/regularizations"));
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [adding, setAdding] = useState(false);
  const rows = (list.data ?? []).filter(
    (r) =>
      !r.batch_id &&
      (status === "all" || r.status === status) &&
      (kind === "all" || KIND_LABEL[r.kind] === KIND_LABEL[kind]),
  );
  return (
    <>
      <Btn title="+ New request" onPress={() => setAdding(true)} />
      <Segments
        options={[["all", "All"], ["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"]]}
        value={status}
        onChange={setStatus}
      />
      <View style={d.wrap}>
        {[["all", "All types"] as [string, string], ...KINDS.map(([v]) => [v, KIND_LABEL[v]] as [string, string])].map(([v, l]) => (
          <Pressable key={v} onPress={() => setKind(v)} style={[d.chip, kind === v && d.chipOn]}>
            <Text style={[d.chipText, kind === v && { color: "#fff" }]}>{l}</Text>
          </Pressable>
        ))}
      </View>
      <Status loading={list.loading} error={list.error} />
      {!list.loading && rows.length === 0 && (
        <EmptyCard title="No requests" text="Requests to correct your attendance appear here." />
      )}
      {rows.map((r) => (
        <View key={r.id} style={d.logCard}>
          <DateBlock date={r.date} />
          <View style={[d.logBar, { backgroundColor: TONE[STATUS_TONE[r.status] ?? "grey"][0] }]} />
          <View style={d.logBody}>
            {(r.in_time || r.out_time) && (
              <View style={d.rowBetween}>
                <Text style={d.timeLine}>
                  In <Text style={d.timeIn}>{r.in_time ?? "—"}</Text>
                </Text>
                <Text style={d.timeLine}>
                  Out <Text style={d.timeOut}>{r.out_time ?? "—"}</Text>
                </Text>
              </View>
            )}
            <View style={d.rowBetween}>
              <Text style={d.strong}>{KIND_LABEL[r.kind] ?? r.kind}</Text>
              <Tag text={STATUS_WORD[r.status] ?? r.status} tone={STATUS_TONE[r.status] ?? "grey"} />
            </View>
            <Text style={d.note}>{r.reason}</Text>
            {r.decision_note ? <Text style={d.note}>Note: {r.decision_note}</Text> : null}
            {r.status === "pending" && !r.from_punch && (
              <Pressable
                accessibilityRole="button"
                style={d.smallBtn}
                onPress={async () => {
                  if (await attempt(() => api(`/regularizations/${r.id}/cancel`, {}))) void list.reload();
                }}
              >
                <Text style={d.smallBtnText}>Withdraw</Text>
              </Pressable>
            )}
          </View>
        </View>
      ))}
      <RequestSheet
        api={api}
        date={null}
        visible={adding}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          void list.reload();
        }}
      />
    </>
  );
}

// ---- Multiple OD --------------------------------------------------------------------------------
export function MultipleOdScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Correction[]>("/regularizations"));
  const [status, setStatus] = useState("all");
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [purpose, setPurpose] = useState("");
  const [working, setWorking] = useState(false);
  const batches = useMemo(() => {
    const m = new Map<string, Correction[]>();
    for (const r of list.data ?? []) if (r.batch_id) m.set(r.batch_id, [...(m.get(r.batch_id) ?? []), r]);
    return [...m.values()]
      .map((rows) => {
        const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
        const st = rows.every((r) => r.status === rows[0].status) ? rows[0].status : "mixed";
        return { rows: sorted, status: st, from: sorted[0].date, to: sorted[sorted.length - 1].date };
      })
      .sort((a, b) => b.from.localeCompare(a.from));
  }, [list.data]);
  const shown = batches.filter((b) => status === "all" || b.status === status);
  return (
    <>
      <Btn title="+ New request" onPress={() => setAdding(true)} />
      <Segments
        options={[["all", "All"], ["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"]]}
        value={status}
        onChange={setStatus}
      />
      <Status loading={list.loading} error={list.error} />
      {!list.loading && shown.length === 0 && (
        <EmptyCard title="No Multiple OD requests" text="Ask for OD for several days at once, such as a tour or a branch visit." />
      )}
      {shown.map((b) => (
        <View key={b.rows[0].batch_id ?? b.from} style={d.logCard}>
          <DateBlock date={b.from} extra={plural(b.rows.length, "day")} />
          <View style={[d.logBar, { backgroundColor: TONE[STATUS_TONE[b.status] ?? "blue"][0] }]} />
          <View style={d.logBody}>
            <View style={d.rowBetween}>
              <Text style={d.strong}>
                {dmy(b.from)} – {dmy(b.to)}
              </Text>
              <Tag text={b.status === "mixed" ? "Partly decided" : STATUS_WORD[b.status]} tone={STATUS_TONE[b.status] ?? "blue"} />
            </View>
            <Text style={d.note}>{b.rows[0].reason}</Text>
            <View style={d.wrap}>
              {b.rows.map((r) => (
                <Tag key={r.id} text={`${Number(r.date.slice(8))} ${MONTHS[Number(r.date.slice(5, 7)) - 1]}`} tone={STATUS_TONE[r.status] ?? "grey"} />
              ))}
            </View>
          </View>
        </View>
      ))}
      <Sheet visible={adding} title="New Multiple OD" sub="Out on duty for several days: one request for the whole trip." onClose={() => setAdding(false)}>
        <View style={d.row2}>
          <DateField label="From" value={from} onChange={setFrom} />
          <DateField label="To" value={to} onChange={setTo} min={from || undefined} />
        </View>
        <Field label="Purpose and place" value={purpose} onChange={setPurpose} multiline placeholder="e.g. Branch audit, Kota" />
        <Text style={d.note}>Weekly offs, holidays and days on leave are left out. Up to 31 days, and up to 30 days ahead.</Text>
        <Btn
          title={working ? "Sending…" : "Submit request"}
          disabled={working || !from || !to || !purpose.trim()}
          onPress={async () => {
            setWorking(true);
            try {
              const r = await api<{ days: string[]; skipped: number }>("/regularizations/batch", {
                from_date: from,
                to_date: to,
                reason: purpose.trim(),
              });
              Alert.alert(
                "Sent for approval",
                `OD asked for ${plural(r.days.length, "day")}${r.skipped ? `; ${plural(r.skipped, "day")} left out (off, holiday or leave)` : ""}.`,
              );
              setAdding(false);
              setFrom("");
              setTo("");
              setPurpose("");
              void list.reload();
            } catch (e) {
              Alert.alert("Could not send", errorText(e));
            } finally {
              setWorking(false);
            }
          }}
        />
      </Sheet>
    </>
  );
}

// ---- OD tab -------------------------------------------------------------------------------------
type OdToday = {
  od_allowed?: boolean;
  openShift: { in_at: string; source?: string; od_purpose?: string | null } | null;
  todayShift: { in_at: string; out_at: string | null; od_purpose?: string | null } | null;
  openTrip?: { purpose: string; out_at: string } | null;
};
type OdVisit = { id: number; purpose: string; out_at: string; in_at: string | null; status: string };
export function OdScreen({
  api,
  onOdPunch,
  onSection,
}: {
  api: Api;
  onOdPunch: () => void;
  onSection: (s: "Multiple OD" | "OD Log History") => void;
}) {
  const me = useLoad(() => api<OdToday>("/me"));
  const trips = useLoad(() => api<OdVisit[]>("/od-visits"));
  const t = me.data;
  const odOpen = t?.openShift?.source === "od_punch";
  const odDone = !t?.openShift && t?.todayShift?.od_purpose != null;
  const working = !!t?.openShift && !odOpen;
  const label = odOpen
    ? "On OD since " + hhmm(t!.openShift!.in_at)
    : odDone
      ? "OD day sent for approval"
      : working
        ? t?.openTrip
          ? "Out on duty: " + t.openTrip.purpose
          : "Punched in at the office"
        : "Not punched in";
  const action = odOpen
    ? "OD Punch Out"
    : working
      ? t?.openTrip
        ? "OD In"
        : "OD Out"
      : odDone
        ? null
        : "OD Punch In";
  const todayTrips = (trips.data ?? []).filter((v) => v.out_at.slice(0, 10) === today());
  return (
    <>
      <Card>
        <View style={d.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={d.kicker}>STATUS</Text>
            <Text style={d.strongBig}>{me.loading ? "…" : label}</Text>
          </View>
          {action && t?.od_allowed !== false && (
            <Pressable accessibilityRole="button" style={d.primarySmall} onPress={onOdPunch}>
              <Text style={d.primarySmallText}>{action}</Text>
            </Pressable>
          )}
        </View>
        {t && t.od_allowed === false && (
          <Text style={d.note}>OD punch is not switched on for you. Ask HR if you work outside the office.</Text>
        )}
      </Card>
      <Text style={d.section}>Today&apos;s log</Text>
      {odOpen || odDone ? (
        <Card>
          <View style={d.rowBetween}>
            <Text style={d.strong}>OD day</Text>
            <Tag text={odDone ? "Waiting for approval" : "Open"} tone={odDone ? "amber" : "blue"} />
          </View>
          <Text style={d.note}>
            In {hhmm((t?.openShift ?? t?.todayShift)?.in_at ?? null)}
            {t?.todayShift?.out_at ? " · Out " + hhmm(t.todayShift.out_at) : ""}
          </Text>
          <Text style={d.note}>{(t?.openShift ?? t?.todayShift)?.od_purpose}</Text>
        </Card>
      ) : null}
      {todayTrips.map((v) => (
        <Card key={v.id}>
          <View style={d.rowBetween}>
            <Text style={d.strong}>{v.purpose}</Text>
            <Tag text={STATUS_WORD[v.status] ?? (v.status === "open" ? "Out now" : v.status)} tone={v.status === "open" ? "blue" : STATUS_TONE[v.status] ?? "grey"} />
          </View>
          <Text style={d.note}>
            Out {hhmm(v.out_at)} · In {v.in_at ? hhmm(v.in_at) : "—"}
          </Text>
        </Card>
      ))}
      {!odOpen && !odDone && todayTrips.length === 0 && !me.loading && (
        <EmptyCard title="No OD entries today" text="Use the button above when you work away from your office." />
      )}
      <View style={d.row2}>
        <Pressable style={d.linkTile} accessibilityRole="button" onPress={() => onSection("Multiple OD")}>
          <Text style={d.linkTileIcon}>▦</Text>
          <Text style={d.linkTileText}>Multiple OD</Text>
        </Pressable>
        <Pressable style={d.linkTile} accessibilityRole="button" onPress={() => onSection("OD Log History")}>
          <Text style={d.linkTileIcon}>↺</Text>
          <Text style={d.linkTileText}>OD log history</Text>
        </Pressable>
      </View>
    </>
  );
}

// ---- leave --------------------------------------------------------------------------------------
type Balance = {
  leave_type_id: number;
  name: string;
  code: string;
  paid?: boolean;
  unlimited: boolean;
  allow_half_day?: boolean;
  balance: number | null;
  pending?: number;
  taken?: number;
  entitlement?: number | null;
  available: number | null;
};
type LeaveRequest = {
  id: number;
  type_name: string;
  type_code?: string;
  from_date: string;
  to_date: string;
  days: number;
  status: string;
  half_day?: string | null;
  reason?: string | null;
};
const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

export function LeaveHub({ api }: { api: Api }) {
  const [tab, setTab] = useState<"summary" | "request" | "history">("summary");
  const bal = useLoad(() => api<Balance[]>("/leave/balances"));
  const reqs = useLoad(() => api<LeaveRequest[]>("/leave/requests"));
  return (
    <>
      <Segments
        options={[["summary", "Summary"], ["request", "Request"], ["history", "History"]]}
        value={tab}
        onChange={setTab}
      />
      {tab === "summary" && <LeaveSummary bal={bal} />}
      {tab === "request" && (
        <LeaveRequestForm
          api={api}
          balances={bal.data ?? []}
          onDone={() => {
            void bal.reload();
            void reqs.reload();
            setTab("history");
          }}
        />
      )}
      {tab === "history" && (
        <LeaveHistory
          api={api}
          reqs={reqs}
          onChange={() => {
            void bal.reload();
            void reqs.reload();
          }}
        />
      )}
    </>
  );
}
function LeaveSummary({ bal }: { bal: ReturnType<typeof useLoad<Balance[]>> }) {
  const list = bal.data ?? [];
  const limited = list.filter((b) => !b.unlimited);
  const total = limited.reduce((s, b) => s + Number(b.entitlement ?? 0), 0);
  const remaining = limited.reduce((s, b) => s + Number(b.available ?? 0), 0);
  const applied = list.reduce((s, b) => s + Number(b.pending ?? 0), 0);
  const taken = list.reduce((s, b) => s + Number(b.taken ?? 0), 0);
  const lwp = list.filter((b) => b.paid === false).reduce((s, b) => s + Number(b.taken ?? 0), 0);
  const used = total ? ((total - remaining) / total) * 100 : 0;
  return (
    <>
      <Status loading={bal.loading} error={bal.error} />
      <Card>
        <View style={d.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={d.kicker}>REMAINING</Text>
            <Text style={d.bigNumber}>
              {n1(remaining)} <Text style={d.bigUnit}>days</Text>
            </Text>
            <Text style={d.note}>out of {n1(total)} for the year</Text>
          </View>
          <Ring pct={used} label="used" />
        </View>
        <View style={d.row3}>
          <Stat label="Applied" value={n1(applied)} tone="amber" />
          <Stat label="Taken" value={n1(taken)} tone="green" />
          <Stat label="LWP" value={n1(lwp)} tone="red" />
        </View>
      </Card>
      {list.map((b) => {
        const ent = Number(b.entitlement ?? 0);
        const pct = ent ? (Number(b.taken ?? 0) / ent) * 100 : 0;
        return (
          <Card key={b.leave_type_id}>
            <View style={d.rowBetween}>
              <View style={d.codeBadge}>
                <Text style={d.codeBadgeText}>{(b.code || b.name.slice(0, 2)).toUpperCase().slice(0, 3)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={d.strong}>{b.name}</Text>
                <Text style={d.note}>{b.unlimited ? "No limit" : `Entitlement ${n1(ent)} days`}</Text>
              </View>
              {!b.unlimited && <Tag text={`${n1(Number(b.available ?? 0))} left`} tone="green" />}
            </View>
            {!b.unlimited && (
              <>
                <Meter pct={pct} color={C.green} />
                <View style={d.rowBetween}>
                  <Text style={d.note}>{Math.round(pct)}% used</Text>
                  <Text style={d.note}>
                    {n1(Number(b.taken ?? 0))} of {n1(ent)} taken
                  </Text>
                </View>
              </>
            )}
            <View style={d.row3}>
              <Stat label="Applied" value={n1(Number(b.pending ?? 0))} />
              <Stat label="Taken" value={n1(Number(b.taken ?? 0))} />
              <Stat label="LWP" value={n1(b.paid === false ? Number(b.taken ?? 0) : 0)} />
            </View>
          </Card>
        );
      })}
    </>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  const [fg, bg] = tone ? TONE[tone] : [C.ink, "#f6f5f9"];
  return (
    <View style={[d.stat, { backgroundColor: bg }]}>
      <Text style={[d.statLabel, { color: tone ? fg : C.muted }]}>{label}</Text>
      <Text style={[d.statValue, { color: fg }]}>{value}</Text>
    </View>
  );
}
function LeaveRequestForm({ api, balances, onDone }: { api: Api; balances: Balance[]; onDone: () => void }) {
  const [half, setHalf] = useState<"" | "first" | "second">("");
  const [typeId, setTypeId] = useState<number | null>(null);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [reason, setReason] = useState(""),
    [address, setAddress] = useState(""),
    [contact, setContact] = useState(""),
    [cover, setCover] = useState("");
  const [docId, setDocId] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const type = balances.find((b) => b.leave_type_id === typeId);
  return (
    <Card>
      <Text style={d.heading}>Apply for leave</Text>
      <Segments
        options={[["", "Full day"], ["first", "First half"], ["second", "Second half"]]}
        value={half}
        onChange={setHalf}
      />
      <Text style={d.label}>Leave type</Text>
      <View style={d.wrap}>
        {balances.map((b) => (
          <Pressable
            key={b.leave_type_id}
            accessibilityRole="radio"
            accessibilityState={{ selected: typeId === b.leave_type_id }}
            onPress={() => setTypeId(b.leave_type_id)}
            style={[d.chip, typeId === b.leave_type_id && d.chipOn]}
          >
            <Text style={[d.chipText, typeId === b.leave_type_id && { color: "#fff" }]}>
              {b.name}
              {b.unlimited ? "" : ` · ${n1(Number(b.available ?? 0))}`}
            </Text>
          </Pressable>
        ))}
      </View>
      {half && type && type.allow_half_day === false && (
        <Text style={d.error}>{type.name} cannot be taken for half a day.</Text>
      )}
      <View style={d.row2}>
        <DateField label="From" value={from} onChange={setFrom} />
        {!half && <DateField label="To" value={to} onChange={setTo} min={from || undefined} />}
      </View>
      <Field label="Reason" value={reason} onChange={setReason} multiline placeholder="Why are you taking this leave?" />
      <Field label="Address during leave" value={address} onChange={setAddress} placeholder="Where you can be reached" />
      <Field label="Contact number" value={contact} onChange={setContact} keyboardType="numeric" placeholder="e.g. 98290 00000" />
      <Field label="Work handover (optional): employee code" value={cover} onChange={setCover} />
      <Pressable
        accessibilityRole="button"
        style={d.input}
        onPress={async () => {
          try {
            const id = await pickAndUpload(api, "Leave document " + (from || today()));
            if (id) setDocId(id);
          } catch (e) {
            Alert.alert("Could not attach", errorText(e));
          }
        }}
      >
        <Text style={{ color: docId ? C.ink : "#9a9cab" }}>{docId ? "📎 Document attached" : "Attach a medical document (optional)"}</Text>
      </Pressable>
      <Btn
        title={working ? "Sending…" : "Submit request"}
        disabled={working || !typeId || !from}
        onPress={async () => {
          setWorking(true);
          const ok = await attempt(async () => {
            let handover: number | undefined;
            if (cover.trim()) {
              const found = await api<{ id: number; employee_code?: string | null }[]>(
                "/directory?q=" + encodeURIComponent(cover.trim()),
              );
              const p = found.find((x) => (x.employee_code ?? "").toLowerCase() === cover.trim().toLowerCase());
              if (!p) throw new Error("No colleague has employee code " + cover.trim() + ".");
              handover = p.id;
            }
            await api("/leave/requests", {
              leave_type_id: typeId,
              from_date: from,
              to_date: half ? from : to || from,
              half_day: half || undefined,
              reason: reason.trim() || undefined,
              address_on_leave: address.trim() || undefined,
              contact_on_leave: contact.trim() || undefined,
              handover_to: handover,
              document_id: docId ?? undefined,
            });
          }, "Leave request sent for approval.");
          setWorking(false);
          if (ok) onDone();
        }}
      />
    </Card>
  );
}
function LeaveHistory({
  api,
  reqs,
  onChange,
}: {
  api: Api;
  reqs: ReturnType<typeof useLoad<LeaveRequest[]>>;
  onChange: () => void;
}) {
  const [status, setStatus] = useState("all");
  const rows = (reqs.data ?? []).filter((r) => status === "all" || r.status === status);
  return (
    <>
      <Segments
        options={[["all", "All"], ["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"]]}
        value={status}
        onChange={setStatus}
      />
      <Status loading={reqs.loading} error={reqs.error} />
      {!reqs.loading && rows.length === 0 && <EmptyCard title="No leave requests" text="Requests you send appear here." />}
      {rows.map((r) => {
        const p = parts(r.from_date);
        return (
          <View key={r.id} style={d.logCard}>
            <View style={d.dateBlock}>
              <Text style={d.dateDay}>{p.day}</Text>
              <Text style={d.dateSub}>{MONTHS[p.m - 1].toUpperCase()}</Text>
              <Text style={d.dateCode}>{(r.type_code || r.type_name.slice(0, 2)).toUpperCase()}</Text>
            </View>
            <View style={[d.logBar, { backgroundColor: TONE[STATUS_TONE[r.status] ?? "grey"][0] }]} />
            <View style={d.logBody}>
              <View style={d.row2}>
                <View style={[d.fromTo, { backgroundColor: C.blueSoft }]}>
                  <Text style={[d.fromToLabel, { color: C.blue }]}>From</Text>
                  <Text style={[d.fromToValue, { color: C.blue }]}>{dmy(r.from_date)}</Text>
                </View>
                <View style={[d.fromTo, { backgroundColor: C.soft }]}>
                  <Text style={[d.fromToLabel, { color: C.dark }]}>To</Text>
                  <Text style={[d.fromToValue, { color: C.dark }]}>{dmy(r.to_date)}</Text>
                </View>
              </View>
              <View style={d.rowBetween}>
                <Tag text={`${n1(r.days)} day${r.days === 1 ? "" : "s"}${r.half_day ? ` (${r.half_day} half)` : ""}`} />
                <Tag text={STATUS_WORD[r.status] ?? r.status} tone={STATUS_TONE[r.status] ?? "grey"} />
              </View>
              <Text style={d.note}>
                {r.type_name}
                {r.reason ? " · " + r.reason : ""}
              </Text>
              {["pending", "approved"].includes(r.status) && r.to_date >= today() && (
                <Pressable
                  accessibilityRole="button"
                  style={d.smallBtn}
                  onPress={() =>
                    Alert.alert("Cancel this leave?", undefined, [
                      { text: "Keep", style: "cancel" },
                      {
                        text: "Cancel leave",
                        style: "destructive",
                        onPress: async () => {
                          if (await attempt(() => api(`/leave/requests/${r.id}/cancel`, {}))) onChange();
                        },
                      },
                    ])
                  }
                >
                  <Text style={d.smallBtnText}>Cancel</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </>
  );
}

// ---- attendance summary -------------------------------------------------------------------------
export function AttendanceSummaryScreen({ api }: { api: Api }) {
  const { month, setMonth, error, data: c } = useMonth(api);
  const counted = c ? c.days.filter((x) => SHOWN(x.status) && x.status !== "pending").length : 0;
  const present = Number(c?.present ?? 0),
    absent = Number(c?.absent ?? 0),
    leaves = Number(c?.leave_paid ?? 0) + Number(c?.leave_unpaid ?? 0),
    offs = Number(c?.weekly_offs ?? 0),
    hols = Number(c?.holidays ?? 0),
    paid = Number(c?.payable_days ?? 0);
  const pct = (v: number) => (counted ? (v / counted) * 100 : 0);
  const bars: [string, number, string][] = [
    ["Absent", absent, C.dark],
    ["Day off", offs, C.violet],
    ["Holiday", hols, "#b5641b"],
    ["Leave", leaves, C.blue],
    ["Present", present, C.green],
  ];
  const top = Math.max(1, ...bars.map(([, v]) => v));
  return (
    <>
      <MonthPicker value={month} onChange={setMonth} />
      {error ? <Text style={d.error}>{error}</Text> : null}
      {!c && !error && <Status loading error="" />}
      {c && (
        <>
          <Card>
            <View style={d.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={d.kicker}>PRESENT</Text>
                <Text style={d.bigNumber}>
                  {present.toFixed(2)} <Text style={d.bigUnit}>days</Text>
                </Text>
                <Text style={d.note}>out of {counted} days so far</Text>
              </View>
              <Ring pct={pct(present)} label="present" />
            </View>
            <View style={d.row3}>
              <Stat label="Absent" value={absent.toFixed(2)} tone="red" />
              <Stat label="Leave" value={leaves.toFixed(2)} tone="amber" />
              <Stat label="Paid" value={paid.toFixed(2)} tone="green" />
            </View>
          </Card>
          <Card>
            <Text style={d.heading}>Distribution</Text>
            <View style={d.chart} accessibilityLabel={bars.map(([l, v]) => `${l} ${v}`).join(", ")}>
              {bars.map(([l, v, color]) => (
                <View key={l} style={d.chartCol}>
                  <Text style={d.chartValue}>{v}</Text>
                  <View style={[d.chartBar, { height: `${(v / top) * 100}%`, backgroundColor: color }]} />
                  <Text style={d.chartLabel} numberOfLines={1}>
                    {l}
                  </Text>
                </View>
              ))}
            </View>
          </Card>
          <Text style={d.section}>Breakup</Text>
          {(
            [
              ["Days counted", counted, C.violet, false],
              ["Absent", absent, C.dark, true],
              ["Day offs", offs, C.violet, true],
              ["Holidays", hols, "#b5641b", true],
              ["Leave", leaves, C.blue, true],
              ["Present", present, C.green, true],
              ["Paid days", paid, C.green, false],
            ] as [string, number, string, boolean][]
          ).map(([l, v, color, meter]) => (
            <Card key={l} style={{ borderLeftWidth: 4, borderLeftColor: color }}>
              <View style={d.rowBetween}>
                <Text style={d.strong}>{l}</Text>
                <Text style={[d.strongBig, { color }]}>{v.toFixed(2)}</Text>
              </View>
              {meter && (
                <>
                  <Meter pct={pct(v)} color={color} />
                  <Text style={[d.note, { textAlign: "right" }]}>{pct(v).toFixed(1)}%</Text>
                </>
              )}
            </Card>
          ))}
        </>
      )}
    </>
  );
}

// ---- holidays -----------------------------------------------------------------------------------
type HolidayRow = { date: string; name: string; optional?: boolean; branch?: string };
export function HolidaysScreen({ api }: { api: Api }) {
  const year = Number(today().slice(0, 4));
  const hol = useLoad(() => api<HolidayRow[]>("/holidays?year=" + year));
  const [kind, setKind] = useState<"all" | "general" | "restricted">("all");
  const all = hol.data ?? [];
  const general = all.filter((h) => !h.optional),
    restricted = all.filter((h) => h.optional);
  const next = general.find((h) => h.date >= today());
  const rows = kind === "all" ? all : kind === "general" ? general : restricted;
  const thisMonth = today().slice(0, 7);
  return (
    <>
      <Card style={{ backgroundColor: C.red, borderColor: C.red }}>
        <Text style={[d.kicker, { color: "#ffd9df" }]}>HOLIDAY CALENDAR {year}</Text>
        <Text style={[d.bigNumber, { color: "#fff" }]}>
          {all.length} <Text style={[d.bigUnit, { color: "#ffd9df" }]}>holidays this year</Text>
        </Text>
        <Text style={{ color: "#ffd9df" }}>
          {general.length} general · {restricted.length} restricted (optional)
        </Text>
        {next && (
          <View style={d.nextHoliday}>
            <DateBlock date={next.date} extra={MONTHS[parts(next.date).m - 1].toUpperCase()} />
            <View style={{ flex: 1, padding: 12, gap: 4 }}>
              <Text style={d.kicker}>NEXT HOLIDAY</Text>
              <Text style={d.strong}>{next.name}</Text>
            </View>
            <View style={{ paddingRight: 12 }}>
              <Tag text={daysUntil(next.date) === 0 ? "Today" : "In " + plural(daysUntil(next.date), "day")} tone="violet" />
            </View>
          </View>
        )}
      </Card>
      <Segments
        options={[["all", `All ${all.length}`], ["general", `General ${general.length}`], ["restricted", `Restricted ${restricted.length}`]]}
        value={kind}
        onChange={setKind}
      />
      <Status loading={hol.loading} error={hol.error} />
      {!hol.loading && rows.length === 0 && <EmptyCard title="No holidays" text={`None listed for ${year}.`} />}
      {rows.map((h) => {
        const left = daysUntil(h.date);
        const p = parts(h.date);
        return (
          <View key={h.date + h.name} style={d.logCard}>
            <View style={[d.dateBlock, { backgroundColor: "#fff", borderRightWidth: 1, borderColor: C.line }]}>
              <Text style={[d.dateSub, { color: C.red }]}>{MONTHS[p.m - 1].toUpperCase()}</Text>
              <Text style={[d.dateDay, { color: C.ink }]}>{p.day}</Text>
              <Text style={[d.dateSmall, { color: C.muted }]}>{WEEKDAYS[p.wd].toUpperCase()}</Text>
            </View>
            <View style={d.logBody}>
              <View style={d.rowBetween}>
                <Text style={[d.strong, { flex: 1 }]}>{h.name}</Text>
                {h.date.slice(0, 7) === thisMonth && <Tag text="This month" tone="violet" />}
              </View>
              <View style={d.wrap}>
                <Tag text={h.optional ? "Restricted" : "General"} tone={h.optional ? "amber" : "grey"} />
                <Tag text={left < 0 ? "Passed" : left === 0 ? "Today" : "In " + plural(left, "day")} tone={left < 0 ? "grey" : "green"} />
              </View>
            </View>
          </View>
        );
      })}
    </>
  );
}

type OptionalSummary = {
  year: number;
  limit: number;
  counts: { total: number; max_allowed: number; applied: number; approved: number; remaining: number; taken: number };
  holidays: { date: string; name: string; past: boolean; choice: { id: number; status: string; note: string | null } | null }[];
};
export function OptionalHolidayScreen({ api }: { api: Api }) {
  const year = Number(today().slice(0, 4));
  const data = useLoad(() => api<OptionalSummary>("/optional-holidays?year=" + year));
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const s = data.data;
  const chosen =
    picked ??
    new Set((s?.holidays ?? []).filter((h) => ["pending", "approved"].includes(h.choice?.status ?? "")).map((h) => h.date));
  const tiles: [string, number, Tone][] = s
    ? [
        ["Total", s.counts.total, "violet"],
        ["Max allowed", s.counts.max_allowed, "amber"],
        ["Applied", s.counts.applied, "blue"],
        ["Approved", s.counts.approved, "green"],
        ["Remaining", s.counts.remaining, "violet"],
        ["Taken", s.counts.taken, "red"],
      ]
    : [];
  return (
    <>
      <Status loading={data.loading} error={data.error} />
      {s && (
        <>
          <View style={d.tileGrid}>
            {tiles.map(([l, v, tone]) => (
              <View key={l} style={d.tile}>
                <Text style={[d.tileValue, { color: TONE[tone][0] }]}>{v}</Text>
                <Text style={d.note}>{l}</Text>
              </View>
            ))}
          </View>
          <Text style={d.section}>Choose your holidays</Text>
          {s.holidays.length === 0 && <EmptyCard title="No optional holidays" text="HR has not listed any optional holidays this year." />}
          {s.holidays.map((h) => {
            const locked = h.choice?.status === "approved" || (h.past && !chosen.has(h.date));
            const on = chosen.has(h.date);
            return (
              <Pressable
                key={h.date}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: locked }}
                disabled={locked}
                onPress={() => {
                  const next = new Set(chosen);
                  if (on) next.delete(h.date);
                  else next.add(h.date);
                  setPicked(next);
                }}
                style={[d.choice, on && d.choiceOn]}
              >
                <View style={[d.check, on && d.checkOn]}>{on && <Text style={{ color: "#fff", fontWeight: "800" }}>✓</Text>}</View>
                <View style={{ flex: 1 }}>
                  <Text style={d.strong}>{h.name}</Text>
                  <Text style={d.note}>{dmy(h.date)}</Text>
                </View>
                {h.choice && <Tag text={STATUS_WORD[h.choice.status] ?? h.choice.status} tone={STATUS_TONE[h.choice.status] ?? "grey"} />}
              </Pressable>
            );
          })}
          {s.holidays.length > 0 && (
            <Btn
              title={saving ? "Saving…" : "Save selections"}
              disabled={saving || picked === null}
              onPress={async () => {
                setSaving(true);
                const ok = await attempt(
                  () => api("/optional-holidays", { year, dates: [...chosen] }, "PUT"),
                  "Saved. New choices go to your manager for approval.",
                );
                setSaving(false);
                if (ok) {
                  setPicked(null);
                  void data.reload();
                }
              }}
            />
          )}
          <Text style={d.note}>
            You may choose up to {s.limit} a year. An approved choice is a holiday for you only.
          </Text>
        </>
      )}
    </>
  );
}

export const d = StyleSheet.create({
  card: { backgroundColor: "#fff", borderWidth: 1, borderColor: C.line, borderRadius: 18, padding: 16, gap: 10 },
  heading: { color: C.ink, fontSize: 18, fontWeight: "700" },
  section: { color: C.ink, fontSize: 17, fontWeight: "700", marginTop: 4 },
  kicker: { color: C.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  strong: { color: C.ink, fontSize: 15, fontWeight: "600" },
  strongBig: { color: C.ink, fontSize: 18, fontWeight: "700" },
  note: { color: C.muted, fontSize: 13, lineHeight: 19 },
  error: { color: "#8a2a1c", backgroundColor: "#fbe9e6", padding: 12, borderRadius: 10 },
  label: { fontSize: 12, fontWeight: "600", color: "#555867" },
  input: {
    backgroundColor: "#fafafc",
    borderColor: "#e1e0e8",
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    color: C.ink,
    fontSize: 15,
    minHeight: 48,
    justifyContent: "center",
  },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  row2: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  row3: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  rowBetween: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  chip: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 18, backgroundColor: "#fff1f3", minHeight: 36, justifyContent: "center" },
  chipOn: { backgroundColor: C.red },
  chipText: { color: C.red, fontWeight: "600", fontSize: 13 },
  tag: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, alignSelf: "flex-start" },
  tagText: { fontSize: 12, fontWeight: "700" },
  segments: { flexDirection: "row", backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 4, gap: 4 },
  segment: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center", minHeight: 40, justifyContent: "center" },
  segmentOn: { backgroundColor: C.red },
  segmentText: { color: C.ink, fontWeight: "600", fontSize: 13 },
  meter: { height: 8, borderRadius: 4, backgroundColor: "#f0eff4", overflow: "hidden" },
  meterFill: { height: 8, borderRadius: 4 },
  ring: {
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 8,
    borderColor: C.soft,
    borderTopColor: C.red,
    alignItems: "center",
    justifyContent: "center",
  },
  ringValue: { color: C.ink, fontSize: 20, fontWeight: "800" },
  ringLabel: { color: C.muted, fontSize: 11 },
  bigNumber: { color: C.red, fontSize: 34, fontWeight: "800" },
  bigUnit: { color: C.muted, fontSize: 15, fontWeight: "600" },
  stat: { flex: 1, minWidth: 88, borderRadius: 12, padding: 10, gap: 2 },
  statLabel: { fontSize: 12, fontWeight: "600" },
  statValue: { fontSize: 20, fontWeight: "800" },
  monthBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  monthArrow: { fontSize: 30, color: C.red, paddingHorizontal: 8 },
  monthText: { color: C.ink, fontSize: 16, fontWeight: "700" },
  logCard: { flexDirection: "row", backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: C.line, overflow: "hidden" },
  dateBlock: { width: 76, backgroundColor: C.red, alignItems: "center", justifyContent: "center", paddingVertical: 14, gap: 2 },
  dateDay: { color: "#fff", fontSize: 28, fontWeight: "800" },
  dateSub: { color: "#ffd9df", fontSize: 13, fontWeight: "600" },
  dateSmall: { color: "#ffd9df", fontSize: 11 },
  dateCode: { color: "#fff", fontSize: 12, fontWeight: "800", backgroundColor: "rgba(255,255,255,0.18)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginTop: 4 },
  logBar: { width: 4 },
  logBody: { flex: 1, padding: 12, gap: 8 },
  timeLine: { color: C.muted, fontSize: 14, fontWeight: "600" },
  timeIn: { color: C.blue, fontWeight: "800" },
  timeOut: { color: C.dark, fontWeight: "800" },
  smallBtn: { alignSelf: "flex-start", borderWidth: 1, borderColor: C.red, borderRadius: 16, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36 },
  smallBtnText: { color: C.red, fontWeight: "700", fontSize: 13 },
  primarySmall: { backgroundColor: C.red, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 44, justifyContent: "center" },
  primarySmallText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.soft, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 20 },
  calendar: { backgroundColor: "#fff", borderRadius: 18, padding: 16, gap: 12, width: "100%", maxWidth: 420, alignSelf: "center" },
  calGrid: { flexDirection: "row", flexWrap: "wrap" },
  calHead: { width: "14.28%", textAlign: "center", color: C.muted, fontWeight: "700", fontSize: 12, paddingVertical: 4 },
  calCell: { width: "14.28%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 22 },
  calOn: { backgroundColor: C.red },
  calText: { color: C.ink, fontSize: 15 },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    maxHeight: "92%",
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 12,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitle: { color: C.ink, fontSize: 20, fontWeight: "800" },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#f3f2f7", alignItems: "center", justifyContent: "center" },
  codeBadge: { width: 52, height: 52, borderRadius: 14, backgroundColor: C.red, alignItems: "center", justifyContent: "center" },
  codeBadgeText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  fromTo: { flex: 1, minWidth: 110, borderRadius: 12, padding: 10 },
  fromToLabel: { fontSize: 12, fontWeight: "600" },
  fromToValue: { fontSize: 15, fontWeight: "800" },
  chart: { height: 180, flexDirection: "row", alignItems: "flex-end", gap: 10, paddingTop: 20 },
  chartCol: { flex: 1, height: "100%", alignItems: "center", justifyContent: "flex-end", gap: 4 },
  chartBar: { width: "70%", minHeight: 2, borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  chartValue: { color: C.ink, fontWeight: "700", fontSize: 12 },
  chartLabel: { color: C.muted, fontSize: 11 },
  nextHoliday: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 14, overflow: "hidden", marginTop: 6 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { flexGrow: 1, flexBasis: "30%", minWidth: 96, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 14, alignItems: "center", gap: 4 },
  tileValue: { fontSize: 26, fontWeight: "800" },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 14, minHeight: 56 },
  choiceOn: { borderColor: C.red, backgroundColor: "#fff7f8" },
  check: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: "#c9c8d3", alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: C.red, borderColor: C.red },
  linkTile: { flex: 1, minWidth: 130, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: C.line, padding: 16, alignItems: "center", gap: 6, minHeight: 88 },
  linkTileIcon: { fontSize: 22, color: C.red },
  linkTileText: { color: C.ink, fontWeight: "600" },
});
