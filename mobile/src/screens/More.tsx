import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

// Self-service screens for the phone: leave, payslips, attendance requests,
// directory, helpdesk, alerts and profile. Everything talks to the same API as
// the web portal, so the same rules and approvals apply.
export type Api = <T>(
  path: string,
  body?: object,
  method?: string,
) => Promise<T>;
type Props = { api: Api; onSignOut: () => void; onPassword: () => void };

type Balance = {
  leave_type_id: number;
  name: string;
  code: string;
  balance: number | null;
  available: number | null;
  unlimited: boolean;
};
type LeaveRequest = {
  id: number;
  type_name: string;
  from_date: string;
  to_date: string;
  days: number;
  status: string;
  half_day?: string | null;
};
type Holiday = { date: string; name: string };
type Payslip = {
  run_id: number;
  month: string;
  net: number;
  gross: number;
  deductions: number;
  status: string;
};
type PayslipDetail = {
  company: string;
  month: string;
  employee: { name: string; employee_code?: string | null };
  earnings: { name: string; amount: number }[];
  deductions: { name: string; amount: number }[];
  gross_earnings: number;
  total_deductions: number;
  net_pay: number;
  paid_days: number;
  days_in_month: number;
};
type Correction = {
  id: number;
  date: string;
  kind: string;
  status: string;
  reason: string;
};
type Person = {
  id: number;
  name: string;
  employee_code?: string | null;
  designation_name?: string | null;
  department_name?: string | null;
  phone?: string | null;
  email: string;
};
type Ticket = {
  id: number;
  subject: string;
  status: string;
  category: string;
  updated_at: string;
};
type TicketDetail = Ticket & {
  messages: { id: number; author: string; body: string; created_at: string }[];
};
type Note = {
  id: number;
  title: string;
  body?: string | null;
  read_at: string | null;
  created_at: string;
};
type Profile = {
  name: string;
  email: string;
  employee_code?: string | null;
  designation_name?: string | null;
  department_name?: string | null;
  branch_name?: string | null;
  manager_name?: string | null;
  phone?: string | null;
  date_of_joining?: string | null;
};

const SECTIONS = [
  "Leave",
  "Payslips",
  "Requests",
  "Directory",
  "Helpdesk",
  "Alerts",
  "Profile",
] as const;
type Section = (typeof SECTIONS)[number];
const inr = (n: number) =>
  "₹" +
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n ?? 0);
const dateText = (d: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(d.slice(0, 10) + "T00:00:00Z"));
const monthText = (m: string) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(m + "-01T00:00:00Z"));
const KIND: Record<string, string> = {
  missed_punch: "Missed punch",
  wrong_punch: "Wrong punch",
  on_duty: "On duty",
  work_from_home: "Work from home",
};

function Btn({
  title,
  onPress,
  secondary,
  disabled,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[s.btn, secondary && s.btnSecondary, disabled && { opacity: 0.5 }]}
    >
      <Text style={[s.btnText, secondary && { color: "#22684f" }]}>
        {title}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "phone-pad" | "email-address";
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[
          s.input,
          multiline && { minHeight: 80, textAlignVertical: "top" },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="none"
      />
    </View>
  );
}
const Pill = ({ text }: { text: string }) => <Text style={s.pill}>{text}</Text>;

export default function More({ api, onSignOut, onPassword }: Props) {
  const [section, setSection] = useState<Section>("Leave");
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api<{ unread: number }>("/notifications")
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, [api, section]);
  return (
    <View style={{ gap: 14 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {SECTIONS.map((name) => (
          <Pressable
            key={name}
            onPress={() => setSection(name)}
            style={[s.chip, section === name && s.chipOn]}
          >
            <Text style={[s.chipText, section === name && { color: "#fff" }]}>
              {name}
              {name === "Alerts" && unread ? " (" + unread + ")" : ""}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {section === "Leave" && <LeaveScreen api={api} />}
      {section === "Payslips" && <PayslipsScreen api={api} />}
      {section === "Requests" && <RequestsScreen api={api} />}
      {section === "Directory" && <DirectoryScreen api={api} />}
      {section === "Helpdesk" && <HelpdeskScreen api={api} />}
      {section === "Alerts" && <AlertsScreen api={api} onChange={setUnread} />}
      {section === "Profile" && (
        <ProfileScreen
          api={api}
          onSignOut={onSignOut}
          onPassword={onPassword}
        />
      )}
    </View>
  );
}

// A small loader: runs `load` now and on demand, showing errors in place.
function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const run = useCallback(async (quiet: boolean) => {
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    try {
      setData(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reload = useCallback(() => run(false), [run]);
  useEffect(() => {
    // Loads once on mount; state is set after the request returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(true);
  }, [run]);
  return { data, error, loading, reload };
}
const Status = ({ loading, error }: { loading: boolean; error: string }) =>
  loading ? (
    <ActivityIndicator color="#17694f" />
  ) : error ? (
    <Text style={s.error}>{error}</Text>
  ) : null;
async function attempt(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) Alert.alert(done);
    return true;
  } catch (e) {
    Alert.alert(
      "Could not complete",
      e instanceof Error ? e.message : "Please retry.",
    );
    return false;
  }
}

// ---- leave ----------------------------------------------------------------------------------
function LeaveScreen({ api }: { api: Api }) {
  const year = new Date().getFullYear();
  const bal = useLoad(() => api<Balance[]>("/leave/balances"));
  const reqs = useLoad(() => api<LeaveRequest[]>("/leave/requests"));
  const hol = useLoad(() => api<Holiday[]>("/holidays?year=" + year));
  const [form, setForm] = useState(false);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [reason, setReason] = useState("");
  const [half, setHalf] = useState<"" | "first" | "second">("");
  const [working, setWorking] = useState(false);
  const options =
    bal.data?.map((b) => ({ id: b.leave_type_id, name: b.name })) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (hol.data ?? []).filter((h) => h.date >= today).slice(0, 6);
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Leave balance</Text>
        <Status loading={bal.loading} error={bal.error} />
        {(bal.data ?? []).map((b) => (
          <View key={b.leave_type_id} style={s.row}>
            <Text style={s.strong}>{b.name}</Text>
            <Text style={s.note}>
              {b.unlimited
                ? "Unlimited"
                : (b.available ?? 0) + " days available"}
            </Text>
          </View>
        ))}
        <Btn
          title={form ? "Close" : "Apply for leave"}
          secondary={form}
          onPress={() => setForm(!form)}
        />
        {form && (
          <View style={{ gap: 12 }}>
            <Text style={s.label}>Leave type</Text>
            <View style={s.wrap}>
              {options.map((o) => (
                <Pressable
                  key={o.id}
                  onPress={() => setTypeId(o.id)}
                  style={[s.chip, typeId === o.id && s.chipOn]}
                >
                  <Text
                    style={[s.chipText, typeId === o.id && { color: "#fff" }]}
                  >
                    {o.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field
              label="From (YYYY-MM-DD)"
              value={from}
              onChange={setFrom}
              placeholder={today}
            />
            <Field
              label="To (YYYY-MM-DD)"
              value={to}
              onChange={setTo}
              placeholder={today}
            />
            <View style={s.wrap}>
              {(["", "first", "second"] as const).map((h) => (
                <Pressable
                  key={h}
                  onPress={() => setHalf(h)}
                  style={[s.chip, half === h && s.chipOn]}
                >
                  <Text style={[s.chipText, half === h && { color: "#fff" }]}>
                    {h === ""
                      ? "Full day(s)"
                      : h === "first"
                        ? "First half"
                        : "Second half"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field
              label="Reason (optional)"
              value={reason}
              onChange={setReason}
              multiline
            />
            <Btn
              title={working ? "Sending…" : "Send request"}
              disabled={working || !typeId || !from}
              onPress={async () => {
                setWorking(true);
                const ok = await attempt(
                  () =>
                    api("/leave/requests", {
                      leave_type_id: typeId,
                      from_date: from,
                      to_date: half ? from : to || from,
                      half_day: half || undefined,
                      reason: reason || undefined,
                    }),
                  "Leave request sent for approval.",
                );
                setWorking(false);
                if (ok) {
                  setForm(false);
                  setFrom("");
                  setTo("");
                  setReason("");
                  setHalf("");
                  void reqs.reload();
                  void bal.reload();
                }
              }}
            />
          </View>
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>My requests</Text>
        <Status loading={reqs.loading} error={reqs.error} />
        {(reqs.data ?? []).length === 0 && !reqs.loading && (
          <Text style={s.note}>No leave requests yet.</Text>
        )}
        {(reqs.data ?? []).slice(0, 20).map((r) => (
          <View key={r.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>
                {r.type_name} · {r.days} day{r.days === 1 ? "" : "s"}
              </Text>
              <Text style={s.note}>
                {dateText(r.from_date)}
                {r.to_date !== r.from_date ? " – " + dateText(r.to_date) : ""}
              </Text>
            </View>
            <Pill text={r.status} />
            {["pending", "approved"].includes(r.status) &&
              r.to_date >= today && (
                <Pressable
                  onPress={() =>
                    Alert.alert("Cancel this request?", undefined, [
                      { text: "Keep", style: "cancel" },
                      {
                        text: "Cancel request",
                        style: "destructive",
                        onPress: async () => {
                          if (
                            await attempt(() =>
                              api("/leave/requests/" + r.id + "/cancel", {}),
                            )
                          ) {
                            void reqs.reload();
                            void bal.reload();
                          }
                        },
                      },
                    ])
                  }
                >
                  <Text style={s.link}>Cancel</Text>
                </Pressable>
              )}
          </View>
        ))}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Upcoming holidays</Text>
        <Status loading={hol.loading} error={hol.error} />
        {upcoming.map((h) => (
          <View key={h.date} style={s.row}>
            <Text style={s.strong}>{h.name}</Text>
            <Text style={s.note}>{dateText(h.date)}</Text>
          </View>
        ))}
        {!hol.loading && upcoming.length === 0 && (
          <Text style={s.note}>No more holidays listed this year.</Text>
        )}
      </View>
    </>
  );
}

// ---- payslips -------------------------------------------------------------------------------
function PayslipsScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Payslip[]>("/payslips"));
  const [open, setOpen] = useState<PayslipDetail | null>(null);
  if (open)
    return (
      <View style={s.card}>
        <Text style={s.heading}>{monthText(open.month)}</Text>
        <Text style={s.note}>
          {open.employee.name} · paid {open.paid_days} of {open.days_in_month}{" "}
          days
        </Text>
        <Text style={s.label}>Earnings</Text>
        {open.earnings.map((e, i) => (
          <View key={i} style={s.row}>
            <Text style={s.strong}>{e.name}</Text>
            <Text>{inr(e.amount)}</Text>
          </View>
        ))}
        <View style={s.row}>
          <Text style={s.strong}>Gross</Text>
          <Text style={s.strong}>{inr(open.gross_earnings)}</Text>
        </View>
        <Text style={s.label}>Deductions</Text>
        {open.deductions.length === 0 && <Text style={s.note}>None</Text>}
        {open.deductions.map((e, i) => (
          <View key={i} style={s.row}>
            <Text style={s.strong}>{e.name}</Text>
            <Text>{inr(e.amount)}</Text>
          </View>
        ))}
        <View style={s.net}>
          <Text style={s.netLabel}>Net pay</Text>
          <Text style={s.netValue}>{inr(open.net_pay)}</Text>
        </View>
        <Btn title="Back" secondary onPress={() => setOpen(null)} />
      </View>
    );
  return (
    <View style={s.card}>
      <Text style={s.heading}>Payslips</Text>
      <Status loading={list.loading} error={list.error} />
      {(list.data ?? []).length === 0 && !list.loading && (
        <Text style={s.note}>
          {"Payslips appear after your company approves each month's payroll."}
        </Text>
      )}
      {(list.data ?? []).map((p) => (
        <Pressable
          key={p.run_id}
          style={s.row}
          onPress={async () => {
            try {
              setOpen(await api<PayslipDetail>("/payslips/" + p.run_id));
            } catch (e) {
              Alert.alert(
                "Could not open",
                e instanceof Error ? e.message : "Retry.",
              );
            }
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.strong}>{monthText(p.month)}</Text>
            <Text style={s.note}>Gross {inr(p.gross)}</Text>
          </View>
          <Text style={s.strong}>{inr(p.net)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---- attendance requests (missed punch, on duty, work from home) ---------------------------------------
function RequestsScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Correction[]>("/regularizations"));
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState("on_duty");
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today),
    [inT, setInT] = useState("09:30"),
    [outT, setOutT] = useState("18:30"),
    [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const self = kind === "missed_punch" || kind === "wrong_punch";
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Attendance requests</Text>
        <Text style={s.note}>
          Missed a punch, working from the field or from home? Ask your manager
          to approve the day.
        </Text>
        <Btn
          title={form ? "Close" : "New request"}
          secondary={form}
          onPress={() => setForm(!form)}
        />
        {form && (
          <View style={{ gap: 12 }}>
            <View style={s.wrap}>
              {Object.entries(KIND).map(([k, label]) => (
                <Pressable
                  key={k}
                  onPress={() => setKind(k)}
                  style={[s.chip, kind === k && s.chipOn]}
                >
                  <Text style={[s.chipText, kind === k && { color: "#fff" }]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field label="Date (YYYY-MM-DD)" value={date} onChange={setDate} />
            {self && (
              <>
                <Field label="In time (HH:MM)" value={inT} onChange={setInT} />
                <Field
                  label="Out time (HH:MM)"
                  value={outT}
                  onChange={setOutT}
                />
              </>
            )}
            <Field
              label="Reason"
              value={reason}
              onChange={setReason}
              multiline
            />
            <Btn
              title={working ? "Sending…" : "Send request"}
              disabled={working || !reason || !date}
              onPress={async () => {
                setWorking(true);
                const ok = await attempt(
                  () =>
                    api("/regularizations", {
                      kind,
                      date,
                      reason,
                      ...(self ? { in_time: inT, out_time: outT } : {}),
                    }),
                  "Request sent to your manager.",
                );
                setWorking(false);
                if (ok) {
                  setForm(false);
                  setReason("");
                  void list.reload();
                }
              }}
            />
          </View>
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>My requests</Text>
        <Status loading={list.loading} error={list.error} />
        {(list.data ?? []).length === 0 && !list.loading && (
          <Text style={s.note}>None yet.</Text>
        )}
        {(list.data ?? []).slice(0, 25).map((r) => (
          <View key={r.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{KIND[r.kind] ?? r.kind}</Text>
              <Text style={s.note}>{dateText(r.date)}</Text>
            </View>
            <Pill text={r.status} />
            {r.status === "pending" && (
              <Pressable
                onPress={async () => {
                  if (
                    await attempt(() =>
                      api("/regularizations/" + r.id + "/cancel", {}),
                    )
                  )
                    void list.reload();
                }}
              >
                <Text style={s.link}>Cancel</Text>
              </Pressable>
            )}
          </View>
        ))}
      </View>
    </>
  );
}

// ---- directory and referrals ----------------------------------------------------------------------
function DirectoryScreen({ api }: { api: Api }) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [refer, setRefer] = useState(false);
  const [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [note, setNote] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      api<Person[]>("/directory?q=" + encodeURIComponent(q))
        .then((r) => {
          setPeople(r);
          setError("");
        })
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Could not load."),
        );
    }, 300);
    return () => clearTimeout(t);
  }, [api, q]);
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Directory</Text>
        <Field
          label="Search"
          value={q}
          onChange={setQ}
          placeholder="Name, designation or department"
        />
        {!!error && <Text style={s.error}>{error}</Text>}
        {people.slice(0, 40).map((p) => (
          <View key={p.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{p.name}</Text>
              <Text style={s.note}>
                {[p.designation_name, p.department_name]
                  .filter(Boolean)
                  .join(" · ") || p.email}
              </Text>
            </View>
            {!!p.phone && (
              <Text
                style={s.link}
                onPress={() => void Linking.openURL("tel:" + p.phone)}
              >
                {p.phone}
              </Text>
            )}
          </View>
        ))}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Refer a candidate</Text>
        <Text style={s.note}>
          Know someone who would be a good fit? Send their details to HR.
        </Text>
        <Btn
          title={refer ? "Close" : "Refer someone"}
          secondary={refer}
          onPress={() => setRefer(!refer)}
        />
        {refer && (
          <View style={{ gap: 12 }}>
            <Field label="Name" value={name} onChange={setName} />
            <Field
              label="Phone"
              value={phone}
              onChange={setPhone}
              keyboardType="phone-pad"
            />
            <Field
              label="Why are they a good fit?"
              value={note}
              onChange={setNote}
              multiline
            />
            <Btn
              title="Send to HR"
              disabled={!name || !phone}
              onPress={async () => {
                if (
                  await attempt(
                    () =>
                      api("/referrals", {
                        name,
                        phone,
                        note: note || undefined,
                      }),
                    "Thank you. HR has been told.",
                  )
                ) {
                  setRefer(false);
                  setName("");
                  setPhone("");
                  setNote("");
                }
              }}
            />
          </View>
        )}
      </View>
    </>
  );
}

// ---- helpdesk ----------------------------------------------------------------------------------------
function HelpdeskScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Ticket[]>("/tickets"));
  const [open, setOpen] = useState<TicketDetail | null>(null);
  const [form, setForm] = useState(false);
  const [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [reply, setReply] = useState("");
  const show = async (id: number) => {
    try {
      setOpen(await api<TicketDetail>("/tickets/" + id));
    } catch (e) {
      Alert.alert("Could not open", e instanceof Error ? e.message : "Retry.");
    }
  };
  if (open)
    return (
      <View style={s.card}>
        <Text style={s.heading}>{open.subject}</Text>
        <Pill text={open.status.replace("_", " ")} />
        {open.messages.map((m) => (
          <View key={m.id} style={s.bubble}>
            <Text style={s.strong}>{m.author}</Text>
            <Text>{m.body}</Text>
          </View>
        ))}
        {open.status !== "closed" && (
          <>
            <Field label="Reply" value={reply} onChange={setReply} multiline />
            <Btn
              title="Send"
              disabled={!reply}
              onPress={async () => {
                if (
                  await attempt(() =>
                    api("/tickets/" + open.id + "/reply", { body: reply }),
                  )
                ) {
                  setReply("");
                  await show(open.id);
                  void list.reload();
                }
              }}
            />
          </>
        )}
        <Btn title="Back" secondary onPress={() => setOpen(null)} />
      </View>
    );
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Helpdesk</Text>
        <Text style={s.note}>Ask HR or payroll a question.</Text>
        <Btn
          title={form ? "Close" : "New ticket"}
          secondary={form}
          onPress={() => setForm(!form)}
        />
        {form && (
          <View style={{ gap: 12 }}>
            <Field label="Subject" value={subject} onChange={setSubject} />
            <Field label="Details" value={body} onChange={setBody} multiline />
            <Btn
              title="Send"
              disabled={!subject || !body}
              onPress={async () => {
                if (
                  await attempt(
                    () => api("/tickets", { subject, body, category: "other" }),
                    "Ticket sent. You will be notified when HR replies.",
                  )
                ) {
                  setForm(false);
                  setSubject("");
                  setBody("");
                  void list.reload();
                }
              }}
            />
          </View>
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>My tickets</Text>
        <Status loading={list.loading} error={list.error} />
        {(list.data ?? []).length === 0 && !list.loading && (
          <Text style={s.note}>No tickets.</Text>
        )}
        {(list.data ?? []).map((t) => (
          <Pressable key={t.id} style={s.row} onPress={() => void show(t.id)}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{t.subject}</Text>
            </View>
            <Pill text={t.status.replace("_", " ")} />
          </Pressable>
        ))}
      </View>
    </>
  );
}

// ---- alerts ---------------------------------------------------------------------------------------------
function AlertsScreen({
  api,
  onChange,
}: {
  api: Api;
  onChange: (n: number) => void;
}) {
  const list = useLoad(() =>
    api<{ items: Note[]; unread: number }>("/notifications"),
  );
  useEffect(() => {
    if (list.data) onChange(list.data.unread);
  }, [list.data, onChange]);
  return (
    <View style={s.card}>
      <Text style={s.heading}>Alerts</Text>
      <Status loading={list.loading} error={list.error} />
      {(list.data?.unread ?? 0) > 0 && (
        <Btn
          title="Mark all as read"
          secondary
          onPress={async () => {
            await attempt(() => api("/notifications/read", {}));
            void list.reload();
          }}
        />
      )}
      {(list.data?.items ?? []).length === 0 && !list.loading && (
        <Text style={s.note}>Nothing yet.</Text>
      )}
      {(list.data?.items ?? []).map((n) => (
        <Pressable
          key={n.id}
          style={s.row}
          onPress={async () => {
            if (!n.read_at) {
              await api("/notifications/read", { id: n.id }).catch(() => {});
              void list.reload();
            }
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[s.strong, !n.read_at && { color: "#17694f" }]}>
              {!n.read_at ? "● " : ""}
              {n.title}
            </Text>
            {!!n.body && <Text style={s.note}>{n.body}</Text>}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

// ---- profile ----------------------------------------------------------------------------------------------
function ProfileScreen({
  api,
  onSignOut,
  onPassword,
}: {
  api: Api;
  onSignOut: () => void;
  onPassword: () => void;
}) {
  const me = useLoad(() => api<Profile>("/profile"));
  const rows: [string, string | null | undefined][] = me.data
    ? [
        ["Name", me.data.name],
        ["Employee code", me.data.employee_code],
        ["Designation", me.data.designation_name],
        ["Department", me.data.department_name],
        ["Branch", me.data.branch_name],
        ["Reports to", me.data.manager_name],
        ["Email", me.data.email],
        ["Phone", me.data.phone],
        [
          "Joined",
          me.data.date_of_joining ? dateText(me.data.date_of_joining) : null,
        ],
      ]
    : [];
  return (
    <View style={s.card}>
      <Text style={s.heading}>My profile</Text>
      <Status loading={me.loading} error={me.error} />
      {rows.map(([label, value]) => (
        <View key={label} style={s.row}>
          <Text style={s.note}>{label}</Text>
          <Text style={s.strong}>{value || "—"}</Text>
        </View>
      ))}
      <Btn title="Change password" secondary onPress={onPassword} />
      <Btn title="Sign out" secondary onPress={onSignOut} />
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e1eae3",
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  heading: {
    color: "#213c30",
    fontSize: 21,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  label: { fontSize: 12, fontWeight: "600", color: "#496252" },
  input: {
    backgroundColor: "#f9fbf9",
    borderColor: "#dce6df",
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    color: "#213c30",
    fontSize: 15,
  },
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    backgroundColor: "#17694f",
    borderRadius: 12,
    alignItems: "center",
  },
  btnSecondary: { backgroundColor: "#e8f0e9" },
  btnText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: "#e8f0e9",
  },
  chipOn: { backgroundColor: "#17694f" },
  chipText: { color: "#22684f", fontWeight: "600", fontSize: 13 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "#eef3ef",
  },
  strong: { fontWeight: "600", color: "#3b5946", fontSize: 14 },
  note: { color: "#7a8c7e", fontSize: 12, lineHeight: 18 },
  link: { color: "#17694f", fontWeight: "600", fontSize: 13 },
  error: {
    color: "#894a35",
    backgroundColor: "#f9eae3",
    padding: 12,
    borderRadius: 10,
  },
  pill: {
    backgroundColor: "#e8f0e9",
    color: "#22684f",
    fontSize: 11,
    fontWeight: "600",
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 10,
    overflow: "hidden",
    textTransform: "capitalize",
    alignSelf: "flex-start",
  },
  net: {
    backgroundColor: "#193c30",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  netLabel: { color: "#cfe5d6", fontWeight: "600" },
  netValue: { color: "#fff", fontSize: 22, fontWeight: "700" },
  bubble: { backgroundColor: "#f1f6f1", borderRadius: 12, padding: 12, gap: 4 },
});
