import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

// Self-service screens for the phone: leave, messages, the Laxmi assistant,
// payslips, attendance requests, directory, helpdesk, alerts and profile. Everything talks to the same API as
// the web portal, so the same rules and approvals apply.
export type Api = <T>(
  path: string,
  body?: object,
  method?: string,
) => Promise<T>;
type Props = {
  api: Api;
  userId: number;
  section: Section;
  onSection: (s: Section) => void;
  onPunch: () => void;
  onSlidePunch: () => Promise<void>;
  onCounts: (alerts: number, messages: number) => void;
  files: Files;
  onSignOut: () => void;
  onPassword: () => void;
};

type Balance = {
  leave_type_id: number;
  name: string;
  code: string;
  pending?: number;
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
  email: string | null;
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

type ChatRoom = {
  id: number;
  kind: "direct" | "group" | "team";
  title: string;
  members: number;
  unread: number | string;
  last_body: string | null;
  last_from: string | null;
};
type ChatMessage = {
  id: number;
  room_id?: number;
  user_id: number;
  author: string;
  body: string;
  created_at: string;
  file_id?: number | null;
  file_name?: string | null;
};
type RoomInfo = {
  id: number;
  kind: "direct" | "group" | "team";
  name: string | null;
  is_admin: boolean;
  members: {
    id: number;
    name: string;
    is_admin: number | boolean;
    last_read_id?: number;
  }[];
};
type ChatPerson = {
  id: number;
  name: string;
  employee_code?: string | null;
  designation?: string | null;
};
type ChatUpdates = { messages: ChatMessage[]; unread: number; latest: number };
type LeaveAction = {
  type: "leave_request";
  leave_type_id: number | null;
  from_date: string;
  to_date: string;
  half_day: "first" | "second" | null;
  reason: string | null;
  options: {
    leave_type_id: number;
    name: string;
    available: number | null;
    allow_half_day?: boolean;
  }[];
};
type BotAnswer = {
  id?: number;
  text: string;
  action?: LeaveAction | null;
  links?: string[];
  helpful?: boolean | number | null;
};
type BotEntry = { key: string; question?: string; answer?: BotAnswer; error?: string };

export const SECTIONS = [
  "Home",
  "My Attendance",
  "Leave",
  "Messages",
  "Ask Laxmi",
  "Payslips",
  "Requests",
  "OD Log History",
  "Directory",
  "Helpdesk",
  "Alerts",
  "Profile",
] as const;
export type Section = (typeof SECTIONS)[number];
// The phone menu, grouped like the web portal and the company's earlier HR portal.
// "Punch" is the attendance screen itself, drawn by the parent.
export const MENU: [string, [Section | "Punch", string][]][] = [
  ["Home", [["Home", "Home"]]],
  [
    "Attendance",
    [
      ["Punch", "Punch In / Out"],
      ["My Attendance", "My Attendance"],
      ["Requests", "Regularization"],
      ["OD Log History", "OD Log History"],
    ],
  ],
  ["Leave", [["Leave", "My Leaves"]]],
  ["TDS", [["Payslips", "Payslips"]]],
  [
    "Employee",
    [
      ["Profile", "My Profile"],
      ["Directory", "Directory & Referrals"],
    ],
  ],
  [
    "Connect",
    [
      ["Messages", "Messages"],
      ["Ask Laxmi", "Ask Laxmi"],
      ["Helpdesk", "Helpdesk"],
      ["Alerts", "Alerts"],
    ],
  ],
];
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
      <Text style={[s.btnText, secondary && { color: "#4e5aa8" }]}>
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

export default function More({
  api,
  userId,
  section,
  onSection,
  onPunch,
  onSlidePunch,
  onCounts,
  files,
  onSignOut,
  onPassword,
}: Props) {
  const [unread, setUnread] = useState(0);
  const [chatUnread, setChatUnread] = useState(0);
  useEffect(() => {
    api<{ unread: number }>("/notifications")
      .then((r) => setUnread(r.unread))
      .catch(() => {});
    // The Messages screen keeps this current itself while it is open.
    if (section !== "Messages")
      api<ChatUpdates>("/chat/updates")
        .then((r) => setChatUnread(Number(r.unread)))
        .catch(() => {});
  }, [api, section]);
  useEffect(() => {
    onCounts(unread, chatUnread);
  }, [unread, chatUnread, onCounts]);
  return (
    <View style={{ gap: 14 }}>
      <Text style={s.crumb}>
        {MENU.find(([, items]) => items.some(([id]) => id === section))?.[0]}
        {section === "Home" ? "" : " / " + section}
      </Text>
      {section === "Home" && (
        <HomeScreen
          api={api}
          files={files}
          onSection={onSection}
          onSlidePunch={onSlidePunch}
          onOdPunch={onPunch}
        />
      )}
      {section === "My Attendance" && <MyAttendanceScreen api={api} />}
      {section === "Leave" && <LeaveScreen api={api} />}
      {section === "Messages" && (
        <MessagesScreen
          api={api}
          files={files}
          userId={userId}
          onUnread={setChatUnread}
        />
      )}
      {section === "Ask Laxmi" && <LaxmiScreen api={api} onGoto={onSection} />}
      {section === "Payslips" && <PayslipsScreen api={api} files={files} />}
      {section === "Requests" && <RequestsScreen api={api} />}
      {section === "OD Log History" && <OdLogScreen api={api} />}
      {section === "Directory" && <DirectoryScreen api={api} />}
      {section === "Helpdesk" && <HelpdeskScreen api={api} />}
      {section === "Alerts" && <AlertsScreen api={api} onChange={setUnread} />}
      {section === "Profile" && (
        <ProfileWithDetails
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
    <ActivityIndicator color="#4e5aa8" />
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

// ---- punch button ---------------------------------------------------------------------------
// One tap punches in or out. The punch itself still needs the selfie and location checks.
function PunchButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => Promise<void> | void;
}) {
  const [working, setWorking] = useState(false);
  return (
    <Pressable
      style={({ pressed }) => [
        s.punchBtn,
        pressed && { opacity: 0.8 },
        (disabled || working) && { opacity: 0.55 },
      ]}
      disabled={disabled || working}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={async () => {
        setWorking(true);
        try {
          await onPress();
        } finally {
          setWorking(false);
        }
      }}
    >
      {working ? <ActivityIndicator color="#ac051b" /> : <Text style={s.punchBtnText}>{label}</Text>}
    </Pressable>
  );
}

// The top of Home: the punch-in time, the punch button, and two tiles.
// OD Punch In opens the punch screen, which asks for the purpose.
function PunchHero({
  today,
  leaves,
  onSlidePunch,
  onOdPunch,
}: {
  today: TodayInfo | null;
  leaves: number | null;
  onSlidePunch: () => Promise<void>;
  onOdPunch: () => void;
}) {
  const open = today?.openShift,
    done = today?.todayShift;
  const odOpen = open?.source === "od_punch",
    odDone = !open && done?.od_purpose != null;
  const date = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());
  return (
    <View style={s.hero}>
      <View style={s.heroBlob} />
      <View style={s.heroBlob2} />
      <View style={s.timeBox}>
        <Text style={s.timeLabel}>{open ? "Time In" : done ? "Time Out" : "Not punched in"}</Text>
        <Text style={s.timeValue}>
          {open ? clock(open.in_at) : done?.out_at ? clock(done.out_at) : "--:--"}
        </Text>
      </View>
      <PunchButton
        label={
          odOpen
            ? "OD Punch Out"
            : odDone
              ? "OD sent for approval"
              : open
                ? "Punch Out"
                : done
                  ? "Update Punch Out"
                  : "Punch In"
        }
        disabled={!today || odDone}
        onPress={onSlidePunch}
      />
      {!open && !done && today?.user?.od_punch && (
        <Pressable
          style={({ pressed }) => [s.odBtn, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          onPress={onOdPunch}
        >
          <Text style={s.odBtnText}>OD Punch In (on duty outside)</Text>
        </Pressable>
      )}
      <View style={s.tiles}>
        <View style={[s.tile, { backgroundColor: "#3aa0f0" }]}>
          <Text style={s.tileLabel}>Leaves Remaining</Text>
          <Text style={s.tileValue}>{leaves ?? "—"}</Text>
        </View>
        <View
          style={[
            s.tile,
            { backgroundColor: open ? "#5fcf80" : done ? "#8f9bd9" : "#f0a04b" },
          ]}
        >
          <Text style={s.tileLabel}>{date}</Text>
          <Text style={s.tileValue}>
            {open ? "Working" : done ? "Done" : "Not in"}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ---- home -----------------------------------------------------------------------------------
// The same cards as the web Home page: employee search, leave balance, announcements,
// holidays, birthdays, the reporting line and today's attendance.
type HomePerson = {
  id: number;
  name: string;
  employee_code?: string | null;
  designation?: string | null;
  department?: string | null;
  branch?: string | null;
};
type HomeData = {
  me: HomePerson | null;
  month: number;
  birthdays: (HomePerson & { day: number })[];
  joiners: (HomePerson & { date_of_joining: string })[];
  org: { manager: HomePerson | null; reports: HomePerson[] };
};
type Announcement = {
  id: number;
  title: string;
  body: string;
  pinned: number | boolean;
  created_at: string;
  author: string | null;
};
type HolidayRow = {
  date: string;
  name: string;
  optional?: boolean;
  branch?: string;
};
type TodayInfo = {
  user?: { od_punch?: boolean };
  openShift: { in_at: string; workplace_name: string; source?: string } | null;
  todayShift: { in_at: string; out_at: string | null; od_purpose?: string | null } | null;
  workplace: { name: string } | null;
};
const MONTHS = [
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
const DOTS = ["#222", "#c95bb8", "#d9303e", "#1e9be0", "#2f9d62", "#e08a1e"];
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const initialsOf = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
const clock = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

function HomeScreen({
  api,
  files,
  onSection,
  onSlidePunch,
  onOdPunch,
}: {
  api: Api;
  files: Files;
  onSection: (s: Section) => void;
  onSlidePunch: () => Promise<void>;
  onOdPunch: () => void;
}) {
  const year = new Date().getFullYear();
  const home = useLoad(() => api<HomeData>("/home"));
  const bal = useLoad(() => api<Balance[]>("/leave/balances"));
  const news = useLoad(() => api<Announcement[]>("/announcements"));
  const hol = useLoad(() => api<HolidayRow[]>("/holidays?year=" + year));
  const today = useLoad(() => api<TodayInfo>("/me"));
  const [optional, setOptional] = useState(false);
  const [allHolidays, setAllHolidays] = useState(false);
  const [code, setCode] = useState(""),
    [name, setName] = useState("");
  const [found, setFound] = useState<Person[] | null>(null);
  const search = async () => {
    const c = code.trim().toLowerCase(),
      n = name.trim().toLowerCase();
    if (!c && !n) return;
    try {
      const rows = await api<Person[]>(
        "/directory?q=" + encodeURIComponent(c || n),
      );
      setFound(
        rows.filter(
          (p) =>
            (!c || (p.employee_code ?? "").toLowerCase().includes(c)) &&
            (!n || p.name.toLowerCase().includes(n)),
        ),
      );
    } catch (e) {
      Alert.alert("Could not search", errorText(e));
    }
  };
  const list = bal.data ?? [];
  const total = list
    .filter((b) => !b.unlimited)
    .reduce((n, b) => n + Number(b.available ?? 0), 0);
  const holidays = (hol.data ?? []).filter((h) => !!h.optional === optional);
  const node = (p: HomePerson, me?: boolean) => (
    <View key={p.id} style={[s.orgNode, me && s.orgMe]}>
      <Text style={s.strong}>{p.name}</Text>
      <Text style={s.note}>{p.designation || p.employee_code || ""}</Text>
    </View>
  );
  return (
    <>
      <PunchHero
        today={today.data}
        leaves={bal.data ? total : null}
        onSlidePunch={async () => {
          await onSlidePunch();
          void today.reload();
          void bal.reload();
        }}
        onOdPunch={onOdPunch}
      />
      <View style={s.card}>
        <Text style={s.heading}>Employee Search</Text>
        <Field label="Code" value={code} onChange={setCode} />
        <Field label="Name" value={name} onChange={setName} />
        <Btn title="Search" onPress={() => void search()} />
        {found?.length === 0 && <Text style={s.note}>Nobody found.</Text>}
        {(found ?? []).slice(0, 30).map((p) => (
          <View key={p.id} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>
                {p.name}
                {p.employee_code ? " (" + p.employee_code + ")" : ""}
              </Text>
              <Text style={s.note}>
                {[p.designation_name, p.department_name]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            {!!p.phone && (
              <Text
                style={s.link}
                onPress={() => void Linking.openURL("tel:" + p.phone)}
              >
                Call
              </Text>
            )}
          </View>
        ))}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>My Leave Balance</Text>
        <View style={s.row}>
          <Text style={s.note}>Leave Summary For Year</Text>
          <Text style={s.strong}>{year}</Text>
        </View>
        <Status loading={bal.loading} error={bal.error} />
        {list.map((b, i) => (
          <View key={b.leave_type_id} style={s.row}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View
                  style={[s.dot, { backgroundColor: DOTS[i % DOTS.length] }]}
                />
                <Text style={s.strong}>
                  {b.code ? b.code + " (" + b.name + ")" : b.name}
                </Text>
              </View>
              <Text style={[s.note, { marginLeft: 20 }]}>
                {b.unlimited ? "No limit" : (b.available ?? 0) + " Leaves"}
              </Text>
            </View>
            <Text style={s.applied}>{(b.pending ?? 0) + " Applied"}</Text>
          </View>
        ))}
        <View style={s.row}>
          <Text style={s.strong}>Total:</Text>
          <Text style={s.strong}>{total} Days</Text>
        </View>
        <Btn title="Apply for leave" secondary onPress={() => onSection("Leave")} />
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Company Announcement</Text>
        <Status loading={news.loading} error={news.error} />
        {(news.data ?? []).map((a) => (
          <View key={"a" + a.id} style={s.feed}>
            <Text style={s.feedTitle}>
              {a.pinned ? "📌 " : "📣 "}
              {a.title}
            </Text>
            <Text style={s.body}>{a.body}</Text>
            <Text style={s.note}>
              {(a.author ?? "") + " · " + dateText(a.created_at)}
            </Text>
          </View>
        ))}
        {(home.data?.joiners ?? []).map((j) => (
          <View key={"j" + j.id} style={s.feed}>
            <Text style={s.feedTitle}>👤 New Employee</Text>
            <Text style={s.body}>
              {j.name}
              {j.employee_code ? " (" + j.employee_code + ")" : ""} has joined
              {j.department ? " in " + j.department + " department" : ""}
            </Text>
            <Text style={s.note}>{dateText(j.date_of_joining)}</Text>
          </View>
        ))}
        {!news.loading &&
          (news.data ?? []).length === 0 &&
          (home.data?.joiners ?? []).length === 0 && (
            <Text style={s.note}>No announcements yet.</Text>
          )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Holiday List</Text>
        <View style={s.wrap}>
          {[false, true].map((o) => (
            <Pressable
              key={String(o)}
              onPress={() => setOptional(o)}
              style={[s.chip, optional === o && s.chipOn]}
            >
              <Text style={[s.chipText, optional === o && { color: "#fff" }]}>
                {o ? "Optional Holiday" : "Fixed Holiday"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Status loading={hol.loading} error={hol.error} />
        {holidays.slice(0, allHolidays ? undefined : 3).map((h) => (
          <View key={h.date + h.name} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{h.name}</Text>
              <Text style={s.note}>{dmy(h.date)}</Text>
            </View>
            <Text style={s.note}>{h.branch ?? ""}</Text>
          </View>
        ))}
        {holidays.length > 3 && (
          <Btn
            title={allHolidays ? "Show less" : "Expand (" + holidays.length + ")"}
            secondary
            onPress={() => setAllHolidays(!allHolidays)}
          />
        )}
        {!hol.loading && holidays.length === 0 && (
          <Text style={s.note}>
            No {optional ? "optional " : ""}holidays added for {year}.
          </Text>
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Birthdays 🎉</Text>
        <Status loading={home.loading} error={home.error} />
        {(home.data?.birthdays ?? []).map((p) => (
          <View key={p.id} style={s.row}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{initialsOf(p.name)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{p.name}</Text>
              <Text style={s.note}>
                {[p.designation, p.branch].filter(Boolean).join(" · ")}
              </Text>
            </View>
            <Text style={s.note}>
              {p.day} {MONTHS[(home.data?.month ?? 1) - 1]}
            </Text>
          </View>
        ))}
        {!home.loading && (home.data?.birthdays ?? []).length === 0 && (
          <Text style={s.note}>
            No birthdays in {MONTHS[(home.data?.month ?? 1) - 1]}.
          </Text>
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Organisation Structure</Text>
        {home.data && (
          <View style={{ alignItems: "center", gap: 6 }}>
            {home.data.org.manager && node(home.data.org.manager)}
            {home.data.org.manager && <View style={s.orgLine} />}
            {home.data.me && node(home.data.me, true)}
            {home.data.org.reports.length > 0 && <View style={s.orgLine} />}
            <View style={[s.wrap, { justifyContent: "center" }]}>
              {home.data.org.reports.map((p) => node(p))}
            </View>
          </View>
        )}
      </View>
      <GalleryBunches api={api} files={files} />
    </>
  );
}

// ---- my attendance --------------------------------------------------------------------------
type ShiftRow = {
  id: number;
  workplace_name: string;
  in_at: string;
  out_at: string | null;
  day_type?: "full_day" | "half_day" | null;
};
function MyAttendanceScreen({ api }: { api: Api }) {
  const home = useLoad(() => api<HomeData>("/home"));
  const shifts = useLoad(() => api<ShiftRow[]>("/shifts"));
  const [size, setSize] = useState(10);
  const [pageNo, setPageNo] = useState(0);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = home.data?.me;
  const all = shifts.data ?? [];
  const pages = Math.max(1, Math.ceil(all.length / size));
  const rows = all.slice(pageNo * size, pageNo * size + size);
  const hhmm = (ms: number) =>
    String(Math.floor(ms / 3600000)).padStart(2, "0") +
    ":" +
    String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Attendance Details</Text>
        {p && (
          <>
            <Text style={s.strong}>{p.name}</Text>
            {(
              [
                ["Employee Code", p.employee_code],
                ["Department", p.department],
                ["Designation", p.designation],
                ["Location", p.branch],
              ] as const
            ).map(([label, value]) => (
              <View key={label} style={s.row}>
                <Text style={s.note}>{label}</Text>
                <Text style={s.strong}>{value || "—"}</Text>
              </View>
            ))}
          </>
        )}
        <Text style={s.clock}>
          {new Intl.DateTimeFormat("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(now)}
        </Text>
      </View>
      <View style={s.card}>
        <Status loading={shifts.loading} error={shifts.error} />
        {!shifts.loading && all.length === 0 && (
          <Text style={s.note}>Your punches appear here.</Text>
        )}
        {rows.map((r) => {
          const code = !r.out_at ? "W" : r.day_type === "half_day" ? "HD" : "P";
          return (
            <View key={r.id} style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.strong}>{dateText(r.in_at)}</Text>
                <Text style={s.note}>
                  {"In " +
                    clock(r.in_at) +
                    " · Out " +
                    (r.out_at ? clock(r.out_at) : "—") +
                    (r.out_at
                      ? " · " +
                        hhmm(Date.parse(r.out_at) - Date.parse(r.in_at)) +
                        " h"
                      : "")}
                </Text>
                <Text style={s.note}>{r.workplace_name}</Text>
              </View>
              <Pill
                text={
                  code === "P" ? "Present" : code === "HD" ? "Half Day" : "Working"
                }
              />
            </View>
          );
        })}
        {all.length > 0 && (
          <View style={[s.row, { borderBottomWidth: 0 }]}>
            <Btn
              title="Prev"
              secondary
              disabled={pageNo === 0}
              onPress={() => setPageNo(pageNo - 1)}
            />
            <Text style={s.note}>
              Page {pageNo + 1} of {pages}
            </Text>
            <Btn
              title="Next"
              secondary
              disabled={pageNo + 1 >= pages}
              onPress={() => setPageNo(pageNo + 1)}
            />
          </View>
        )}
        {all.length > 10 && (
          <View style={s.wrap}>
            {[10, 20, 50].map((n) => (
              <Pressable
                key={n}
                onPress={() => {
                  setSize(n);
                  setPageNo(0);
                }}
                style={[s.chip, size === n && s.chipOn]}
              >
                <Text style={[s.chipText, size === n && { color: "#fff" }]}>
                  {n} per page
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </>
  );
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
  const [address, setAddress] = useState(""),
    [contact, setContact] = useState("");
  const [cover, setCover] = useState<{ id: number; name: string } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [medical, setMedical] = useState<Picked | null>(null);
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
              label="For the following reason"
              value={reason}
              onChange={setReason}
              multiline
            />
            <Field
              label="My address on leave will be"
              value={address}
              onChange={setAddress}
            />
            <Field
              label="Contact No."
              value={contact}
              onChange={setContact}
              keyboardType="phone-pad"
            />
            <Text style={s.label}>In my absence, work handled by</Text>
            <Pressable onPress={() => setPicking(!picking)} style={s.input}>
              <Text style={{ color: cover ? "#2a2c3a" : "#9a9cab" }}>
                {cover ? cover.name : "Choose a colleague (optional)"}
              </Text>
            </Pressable>
            {picking && (
              <PeoplePicker
                api={api}
                onPick={(id, name) => {
                  setCover({ id, name });
                  setPicking(false);
                }}
              />
            )}
            <Text style={s.label}>Upload Medical Document (optional)</Text>
            <Pressable
              style={s.input}
              onPress={async () => {
                try {
                  const f = await pickFile();
                  if (f) setMedical(f);
                } catch (e) {
                  Alert.alert("Could not attach", errorText(e));
                }
              }}
            >
              <Text style={{ color: medical ? "#2a2c3a" : "#9a9cab" }}>
                {medical ? "📎 " + medical.name : "Choose a PDF or photo (up to 2 MB)"}
              </Text>
            </Pressable>
            <Btn
              title={working ? "Sending…" : "Send request"}
              disabled={working || !typeId || !from}
              onPress={async () => {
                setWorking(true);
                const ok = await attempt(
                  async () =>
                    api("/leave/requests", {
                      document_id: medical
                        ? (
                            await api<{ id: number }>("/documents", {
                              kind: "medical",
                              name: "Medical, leave from " + from,
                              mime: medical.mime,
                              data: medical.data,
                            })
                          ).id
                        : undefined,
                      leave_type_id: typeId,
                      from_date: from,
                      to_date: half ? from : to || from,
                      half_day: half || undefined,
                      reason: reason || undefined,
                      address_on_leave: address || undefined,
                      contact_on_leave: contact || undefined,
                      handover_to: cover?.id,
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
                  setAddress("");
                  setContact("");
                  setCover(null);
                  setMedical(null);
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

// ---- messages (internal chat) -----------------------------------------------------------------------
// New messages arrive by polling /chat/updates every few seconds while this section
// is open, the same as the web portal. Groups are created on the web; here people
// can read, reply and leave them.
const CHAT_POLL_MS = 5000;
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Please retry.";
const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
const chatTime = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    ...(iso.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? {}
      : { day: "numeric", month: "short" }),
  }).format(new Date(iso));
// Adds messages once each, oldest first: a poll and a send can both report the same one.
const merge = (list: ChatMessage[], more: ChatMessage[]) =>
  [...list, ...more.filter((m) => !list.some((x) => x.id === m.id))].sort(
    (a, b) => a.id - b.id,
  );

function MessagesScreen({
  api,
  files,
  userId,
  onUnread,
}: {
  api: Api;
  files: Files;
  userId: number;
  onUnread: (n: number) => void;
}) {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [error, setError] = useState("");
  const [room, setRoom] = useState<number | null>(null);
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [earlier, setEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const roomRef = useRef<number | null>(null);
  const latest = useRef<number | null>(null);
  const polling = useRef(false);

  const loadRooms = useCallback(async () => {
    try {
      setRooms(await api<ChatRoom[]>("/chat/rooms"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const since = latest.current === null ? "" : "?since=" + latest.current;
        const data = await api<ChatUpdates>("/chat/updates" + since);
        if (stopped) return;
        const fresh = latest.current === null ? [] : data.messages;
        latest.current = data.latest;
        let unread = Number(data.unread);
        const open = roomRef.current;
        const here = fresh.filter((m) => m.room_id === open);
        if (open !== null && here.length) {
          setMessages((list) => merge(list, here));
          await api("/chat/rooms/" + open + "/read", {
            message_id: here[here.length - 1].id,
          }).catch(() => {});
          unread = Math.max(
            0,
            unread - here.filter((m) => m.user_id !== userId).length,
          );
        }
        onUnread(unread);
        if (fresh.length) void loadRooms();
        // Refresh who has read what, for the ticks on my messages.
        if (open !== null) {
          const i = await api<RoomInfo>("/chat/rooms/" + open).catch(() => null);
          if (i && roomRef.current === open && !stopped) setInfo(i);
        }
      } catch {
        // offline for a moment; try again on the next tick
      } finally {
        polling.current = false;
      }
    };
    // Loads the list once on open; state is set after the request returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRooms();
    void poll();
    const timer = setInterval(() => void poll(), CHAT_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, userId, onUnread, loadRooms]);

  const close = () => {
    roomRef.current = null;
    setRoom(null);
    setInfo(null);
    setMessages([]);
    void loadRooms();
  };
  const openRoom = async (id: number) => {
    roomRef.current = id;
    setRoom(id);
    setInfo(null);
    setMessages([]);
    setEarlier(false);
    setDraft("");
    try {
      const [i, m] = await Promise.all([
        api<RoomInfo>("/chat/rooms/" + id),
        api<{ messages: ChatMessage[] }>("/chat/rooms/" + id + "/messages"),
      ]);
      if (roomRef.current !== id) return;
      setInfo(i);
      setMessages((list) => merge(list, m.messages));
      setEarlier(m.messages.length === 50);
      const last = m.messages[m.messages.length - 1]?.id;
      if (last) {
        await api("/chat/rooms/" + id + "/read", { message_id: last });
        const r = await api<ChatUpdates>("/chat/updates");
        onUnread(Number(r.unread));
        void loadRooms();
      }
    } catch (e) {
      if (roomRef.current !== id) return;
      Alert.alert("Could not open", errorText(e));
      close();
    }
  };
  const showEarlier = async () => {
    const id = room,
      first = messages[0]?.id;
    if (id === null || !first) return;
    try {
      const r = await api<{ messages: ChatMessage[] }>(
        "/chat/rooms/" + id + "/messages?before=" + first,
      );
      if (roomRef.current !== id) return;
      setMessages((list) => merge(r.messages, list));
      setEarlier(r.messages.length === 50);
    } catch (e) {
      Alert.alert("Could not load", errorText(e));
    }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || room === null) return;
    setSending(true);
    try {
      const r = await api<{ id: number; created_at: string }>(
        "/chat/rooms/" + room + "/messages",
        { body: text },
      );
      setDraft("");
      setMessages((list) =>
        merge(list, [
          {
            id: r.id,
            user_id: userId,
            author: "You",
            body: text,
            created_at: r.created_at,
          },
        ]),
      );
      void loadRooms();
    } catch (e) {
      Alert.alert("Could not send", errorText(e));
    } finally {
      setSending(false);
    }
  };
  const unsend = (m: ChatMessage) =>
    Alert.alert("Delete this message?", "It disappears for everyone.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (
            await attempt(() =>
              api("/chat/messages/" + m.id, undefined, "DELETE"),
            )
          ) {
            setMessages((list) => list.filter((x) => x.id !== m.id));
            void loadRooms();
          }
        },
      },
    ]);
  const leave = (g: RoomInfo) =>
    Alert.alert(
      "Leave " + (g.name ?? "this group") + "?",
      "You will no longer see its messages.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Leave group",
          style: "destructive",
          onPress: async () => {
            if (
              await attempt(() =>
                api(
                  "/chat/rooms/" + g.id + "/members/" + userId,
                  undefined,
                  "DELETE",
                ),
              )
            )
              close();
          },
        },
      ],
    );

  if (room !== null) {
    // Ticks on my messages: seen by the other person, or by how many in a group.
    const readers = (info?.members ?? []).filter((x) => x.id !== userId);
    const ticks = (id: number) => {
      const seen = readers.filter((r) => (r.last_read_id ?? 0) >= id).length;
      if (!seen) return "✓ Sent";
      return readers.length <= 1
        ? "✓✓ Seen"
        : "✓✓ Seen by " + seen + " of " + readers.length;
    };
    const title = info
      ? info.kind !== "direct"
        ? (info.name ?? "Group")
        : (info.members.find((m) => m.id !== userId)?.name ??
          "Former colleague")
      : (rooms?.find((r) => r.id === room)?.title ?? "");
    return (
      <View style={s.card}>
        <View style={[s.row, { paddingTop: 0 }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.heading}>{title}</Text>
            <Text style={s.note}>
              {info?.kind === "team"
                ? "HR team only · " + info.members.length + " people"
                : info?.kind === "group"
                ? info.members.length + " people"
                : "Direct message"}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={close}>
            <Text style={s.link}>Back</Text>
          </Pressable>
        </View>
        {!info && <ActivityIndicator color="#4e5aa8" />}
        {earlier && (
          <Btn
            title="Show earlier messages"
            secondary
            onPress={() => void showEarlier()}
          />
        )}
        {!!info && messages.length === 0 && (
          <Text style={s.note}>
            Say hello. Messages are visible only to the people in this
            conversation.
          </Text>
        )}
        {messages.map((m) => {
          const mine = m.user_id === userId;
          return (
            <View key={m.id} style={[s.bubble, s.msg, mine && s.msgMine]}>
              <Text style={s.note}>
                {mine ? "You" : m.author} · {chatTime(m.created_at)}
                {mine ? "   " : ""}
                {mine && (
                  <Text style={s.link} onPress={() => unsend(m)}>
                    Delete
                  </Text>
                )}
              </Text>
              {!!m.body && <Text style={s.body}>{m.body}</Text>}
              {!!m.file_id && (
                <Text
                  style={s.link}
                  onPress={() =>
                    void openFile(api, files, "chat_file", m.file_id as number)
                  }
                >
                  📎 {m.file_name}
                </Text>
              )}
              {mine && !!info && (
                <Text
                  style={[
                    s.note,
                    { textAlign: "right", fontSize: 11 },
                    ticks(m.id) !== "✓ Sent" && { color: "#2f7de1" },
                  ]}
                >
                  {ticks(m.id)}
                </Text>
              )}
            </View>
          );
        })}
        {!!info && (
          <>
            <TextInput
              accessibilityLabel="Message"
              style={[s.input, { minHeight: 60, textAlignVertical: "top" }]}
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a message"
              maxLength={2000}
              multiline
            />
            <Btn
              title={sending ? "Sending…" : "Send"}
              disabled={sending || !draft.trim()}
              onPress={() => void send()}
            />
            <Btn
              title="📎 Send a file"
              secondary
              disabled={sending}
              onPress={async () => {
                if (room === null) return;
                try {
                  const f = await pickFile();
                  if (!f) return;
                  setSending(true);
                  await api("/chat/rooms/" + room + "/messages", {
                    body: draft.trim(),
                    file: f,
                  });
                  setDraft("");
                  void openRoom(room);
                } catch (e) {
                  Alert.alert("Could not send", errorText(e));
                } finally {
                  setSending(false);
                }
              }}
            />
          </>
        )}
        {info?.kind === "group" && (
          <>
            <Text style={s.label}>People</Text>
            <Text style={s.note}>
              {info.members.map((m) => m.name).join(", ")}
            </Text>
            <Btn title="Leave group" secondary onPress={() => leave(info)} />
          </>
        )}
      </View>
    );
  }
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Messages</Text>
        <Text style={s.note}>
          Chat with colleagues. New messages arrive every few seconds while
          this screen is open.
        </Text>
        <Btn
          title={picking ? "Close" : "New message"}
          secondary={picking}
          onPress={() => setPicking(!picking)}
        />
        {picking && (
          <PeoplePicker
            api={api}
            onPick={async (id) => {
              try {
                const r = await api<{ id: number }>("/chat/direct", {
                  user_id: id,
                });
                setPicking(false);
                void openRoom(r.id);
              } catch (e) {
                Alert.alert("Could not start", errorText(e));
              }
            }}
          />
        )}
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Conversations</Text>
        <Status loading={rooms === null && !error} error={error} />
        {rooms?.length === 0 && (
          <Text style={s.note}>
            No conversations yet. Start one with New message.
          </Text>
        )}
        {(rooms ?? []).map((r) => (
          <Pressable
            key={r.id}
            style={s.row}
            onPress={() => void openRoom(r.id)}
          >
            <View style={s.avatar}>
              <Text style={s.avatarText}>
                {r.kind === "team" ? "🛡" : r.kind === "group" ? "#" : initials(r.title)}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.strong}>{r.title}</Text>
              <Text style={s.note} numberOfLines={1}>
                {r.last_body
                  ? (r.kind !== "direct" && r.last_from
                      ? r.last_from.split(" ")[0] + ": "
                      : "") + r.last_body
                  : r.kind === "team"
                    ? "HR team only"
                    : r.kind === "group"
                    ? r.members + " people"
                    : "No messages yet"}
              </Text>
            </View>
            {Number(r.unread) > 0 && <Text style={s.count}>{r.unread}</Text>}
          </Pressable>
        ))}
      </View>
    </>
  );
}

// Type to search colleagues, tap one to message them.
function PeoplePicker({
  api,
  onPick,
}: {
  api: Api;
  onPick: (id: number, name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<ChatPerson[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      api<ChatPerson[]>("/chat/people?q=" + encodeURIComponent(q.trim()))
        .then((r) => {
          setPeople(r);
          setError("");
        })
        .catch((e) => setError(errorText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [api, q]);
  return (
    <View style={{ gap: 6 }}>
      <Field
        label="Find a colleague"
        value={q}
        onChange={setQ}
        placeholder="Name or employee code"
      />
      {!!error && <Text style={s.error}>{error}</Text>}
      {people?.length === 0 && <Text style={s.note}>Nobody found.</Text>}
      {(people ?? []).map((p) => (
        <Pressable
          key={p.id}
          style={s.row}
          onPress={() => onPick(p.id, p.name)}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.strong}>{p.name}</Text>
            <Text style={s.note}>
              {[p.designation, p.employee_code].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Text style={s.link}>Message</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---- Laxmi, the HR assistant -------------------------------------------------------------------------
// Links in answers name web portal pages; the ones the phone also has open here.
const BOT_LINKS: Partial<Record<string, Section>> = {
  timeoff: "Leave",
  payslips: "Payslips",
  helpdesk: "Helpdesk",
  mine: "My Attendance",
};
const BOT_SUGGESTIONS = [
  "What is my leave balance?",
  "Apply casual leave tomorrow",
  "Next holidays",
  "When is payday?",
  "Show my last payslip",
  "My attendance this month",
  "My leave history",
];

function LaxmiScreen({
  api,
  onGoto,
}: {
  api: Api;
  onGoto: (section: Section) => void;
}) {
  const [log, setLog] = useState<BotEntry[] | null>(null);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    api<
      {
        id: number;
        question: string;
        answer: string;
        helpful: number | boolean | null;
      }[]
    >("/bot/history")
      .then((h) =>
        setLog(
          h.map((x) => ({
            key: "h" + x.id,
            question: x.question,
            answer: { id: x.id, text: x.answer, helpful: x.helpful },
          })),
        ),
      )
      .catch((e) => {
        setError(errorText(e));
        setLog([]);
      });
  }, [api]);
  const update = (key: string, change: Partial<BotEntry>) =>
    setLog((l) =>
      (l ?? []).map((e) => (e.key === key ? { ...e, ...change } : e)),
    );
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || asking) return;
    const key = "q" + ++asked.current;
    setQuestion("");
    setAsking(true);
    setLog((l) => [...(l ?? []), { key, question: q }]);
    try {
      update(key, {
        answer: await api<BotAnswer>("/bot/ask", { question: q }),
      });
    } catch (e) {
      update(key, { error: errorText(e) });
    } finally {
      setAsking(false);
    }
  };
  const rate = async (e: BotEntry, helpful: boolean) => {
    const a = e.answer;
    if (!a?.id) return;
    if (await attempt(() => api("/bot/log/" + a.id + "/feedback", { helpful })))
      update(e.key, { answer: { ...a, helpful } });
  };
  return (
    <View style={s.card}>
      <Text style={s.heading}>Ask Laxmi</Text>
      <Text style={s.note}>
        {
          "Your HR assistant. Answers come from your own records and the company's published guidance. Every question is kept in a log HR can review."
        }
      </Text>
      <Status loading={log === null} error={error} />
      {log?.length === 0 && !error && (
        <View style={[s.bubble, s.msg]}>
          <Text style={s.strong}>Laxmi</Text>
          <Text style={s.body}>
            Namaste! I can tell you your leave balance, apply for leave, list
            holidays, and answer questions about pay, attendance and company
            policies.
          </Text>
        </View>
      )}
      {(log ?? []).map((e) => {
        const a = e.answer;
        const links = (a?.links ?? []).filter((l) => BOT_LINKS[l]);
        return (
          <React.Fragment key={e.key}>
            {!!e.question && (
              <View style={[s.bubble, s.msg, s.msgMine]}>
                <Text style={s.body}>{e.question}</Text>
              </View>
            )}
            <View
              style={[s.bubble, s.msg, !!a?.action && { maxWidth: "100%" }]}
            >
              <Text style={s.strong}>Laxmi</Text>
              {a ? (
                <>
                  <Text style={s.body}>{a.text}</Text>
                  {a.action?.type === "leave_request" && (
                    <LeaveCard api={api} action={a.action} />
                  )}
                  {links.length > 0 && (
                    <View style={s.wrap}>
                      {links.map((l) => (
                        <Pressable
                          key={l}
                          style={s.chip}
                          onPress={() => onGoto(BOT_LINKS[l] as Section)}
                        >
                          <Text style={s.chipText}>{BOT_LINKS[l]} →</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  {!!a.id &&
                    (a.helpful === null || a.helpful === undefined ? (
                      <Text style={s.note}>
                        Was this helpful?{"   "}
                        <Text style={s.link} onPress={() => void rate(e, true)}>
                          Yes
                        </Text>
                        {"   "}
                        <Text
                          style={s.link}
                          onPress={() => void rate(e, false)}
                        >
                          No
                        </Text>
                      </Text>
                    ) : (
                      <Text style={s.note}>
                        {a.helpful
                          ? "Thanks for the feedback."
                          : "Thanks. HR will review this answer."}
                      </Text>
                    ))}
                </>
              ) : e.error ? (
                <Text style={{ color: "#894a35" }}>{e.error}</Text>
              ) : (
                <Text style={s.note}>Thinking…</Text>
              )}
            </View>
          </React.Fragment>
        );
      })}
      <View style={s.wrap}>
        {BOT_SUGGESTIONS.map((x) => (
          <Pressable
            key={x}
            disabled={asking}
            onPress={() => void ask(x)}
            style={[s.chip, asking && { opacity: 0.5 }]}
          >
            <Text style={s.chipText}>{x}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="Question for Laxmi"
        style={s.input}
        value={question}
        onChangeText={setQuestion}
        placeholder="Ask about leave, holidays, pay or a policy"
        maxLength={500}
        returnKeyType="send"
        onSubmitEditing={() => void ask(question)}
      />
      <Btn
        title={asking ? "Asking…" : "Ask"}
        disabled={asking || !question.trim()}
        onPress={() => void ask(question)}
      />
    </View>
  );
}

// The leave request Laxmi drafted: check it, change anything, then confirm.
function LeaveCard({ api, action }: { api: Api; action: LeaveAction }) {
  const [typeId, setTypeId] = useState<number | null>(action.leave_type_id);
  const [from, setFrom] = useState(action.from_date),
    [to, setTo] = useState(action.to_date),
    [reason, setReason] = useState(action.reason ?? "");
  const [half, setHalf] = useState<"" | "first" | "second">(
    action.half_day ?? "",
  );
  const [working, setWorking] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  if (sent !== null)
    return (
      <Text style={s.callout}>
        Sent for approval: {sent} day{sent === 1 ? "" : "s"}. Follow it under
        Leave.
      </Text>
    );
  const halfAllowed =
    action.options.find((o) => o.leave_type_id === typeId)?.allow_half_day !==
    false;
  const halfDay = halfAllowed ? half : "";
  return (
    <View style={s.draft}>
      <Text style={s.label}>Leave type</Text>
      <View style={s.wrap}>
        {action.options.map((o) => (
          <Pressable
            key={o.leave_type_id}
            onPress={() => setTypeId(o.leave_type_id)}
            style={[s.chip, typeId === o.leave_type_id && s.chipOn]}
          >
            <Text
              style={[
                s.chipText,
                typeId === o.leave_type_id && { color: "#fff" },
              ]}
            >
              {o.name}
              {o.available === null ? "" : " (" + o.available + " left)"}
            </Text>
          </Pressable>
        ))}
      </View>
      <Field label="From (YYYY-MM-DD)" value={from} onChange={setFrom} />
      {!halfDay && (
        <Field label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
      )}
      {halfAllowed && (
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
      )}
      <Field
        label="Reason (optional)"
        value={reason}
        onChange={setReason}
        multiline
      />
      <Btn
        title={working ? "Sending…" : "Confirm and send for approval"}
        disabled={working || !typeId || !from || (!halfDay && !to)}
        onPress={async () => {
          setWorking(true);
          try {
            const r = await api<{ id: number; days: number }>(
              "/leave/requests",
              {
                leave_type_id: typeId,
                from_date: from,
                to_date: halfDay ? from : to,
                half_day: halfDay || null,
                reason: reason.trim() || null,
              },
            );
            setSent(r.days);
          } catch (e) {
            Alert.alert("Could not complete", errorText(e));
          } finally {
            setWorking(false);
          }
        }}
      />
    </View>
  );
}

// ---- files: open through a short-lived link, pick from the phone --------------------------------
// The system viewer cannot send the sign-in token, so the app asks the server for a link
// that works for five minutes and opens that.
export type Files = { base: string; headers: () => Record<string, string> };
async function openFile(api: Api, files: Files, kind: "document" | "chat_file", id: number) {
  try {
    const link = await api<{ url: string }>("/download-links", { kind, id });
    await Linking.openURL(files.base + link.url);
  } catch (e) {
    Alert.alert("Could not open", errorText(e));
  }
}
type Picked = { name: string; mime: string; data: string };
const PICK_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
};
// A PDF or photo up to 2 MB from the phone, as base64; null if the person cancels.
async function pickFile(): Promise<Picked | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: Object.keys(PICK_TYPES),
    copyToCacheDirectory: true,
  });
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  const mime = a.mimeType ?? "";
  if (!PICK_TYPES[mime]) throw new Error("Choose a PDF, JPG or PNG.");
  if ((a.size ?? 0) > 2 * 1024 * 1024) throw new Error("Files can be up to 2 MB.");
  return { name: a.name, mime, data: await new File(a.uri).base64() };
}

// ---- Form 16 ----------------------------------------------------------------------------------
function Form16Card({ api, files }: { api: Api; files: Files }) {
  const list = useLoad(() =>
    api<{ id: number; name: string }[]>("/form16"),
  );
  return (
    <View style={s.card}>
      <Text style={s.heading}>Form 16</Text>
      <Status loading={list.loading} error={list.error} />
      {(list.data ?? []).length === 0 && !list.loading && (
        <Text style={s.note}>
          Your Form 16 appears here once payroll uploads it, usually by
          mid-June.
        </Text>
      )}
      {(list.data ?? []).map((d) => (
        <Pressable
          key={d.id}
          style={s.row}
          onPress={() => void openFile(api, files, "document", d.id)}
        >
          <Text style={s.strong}>{d.name}</Text>
          <Text style={s.link}>Download</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---- engagement gallery: still photos, one bunch per event -------------------------------------
type GalleryPhoto = {
  id: number;
  title: string;
  category: string;
  event_date: string;
  branch_name: string | null;
};
function GalleryBunches({ api, files }: { api: Api; files: Files }) {
  const g = useLoad(() =>
    api<{ items: GalleryPhoto[] }>("/gallery?limit=100"),
  );
  const [album, setAlbum] = useState<GalleryPhoto[] | null>(null);
  const [big, setBig] = useState<number | null>(null);
  const albums: GalleryPhoto[][] = [];
  const byKey = new Map<string, GalleryPhoto[]>();
  for (const p of g.data?.items ?? []) {
    const key = p.title.toLowerCase() + "|" + p.event_date;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      albums.push(byKey.get(key)!);
    }
    byKey.get(key)!.push(p);
  }
  const src = (id: number) => ({
    uri: files.base + "/api/gallery/" + id + "/image",
    headers: files.headers(),
  });
  const tilt = (id: number) => ((Math.sin(id * 9301) + 1) / 2) * 10 - 5;
  return (
    <View style={[s.card, s.galleryCard]}>
      <Text style={s.galleryKicker}>MOMENTS</Text>
      <Text style={[s.heading, { color: "#fff" }]}>Engagement Gallery</Text>
      <Status loading={g.loading} error={g.error} />
      {!g.loading && albums.length === 0 && (
        <Text style={{ color: "#b9bdd6" }}>
          Photos from HR days, celebrations and awards appear here.
        </Text>
      )}
      <View style={s.stacks}>
        {albums.map((a) => (
          <Pressable
            key={a[0].id}
            onPress={() => {
              setAlbum(a);
              setBig(null);
            }}
            style={[s.stack, { transform: [{ rotate: tilt(a[0].id) + "deg" }] }]}
            accessibilityLabel={a[0].title + ", " + a.length + " photos"}
          >
            {a
              .slice(0, 3)
              .reverse()
              .map((p, k, shown) => (
                <Image
                  key={p.id}
                  source={src(p.id)}
                  style={[
                    s.stackPhoto,
                    k < shown.length - 1 && {
                      transform: [{ rotate: (k % 2 ? 8 : -8) + "deg" }],
                    },
                  ]}
                />
              ))}
            <Text style={s.stackCount}>
              {a.length} {a.length === 1 ? "photo" : "photos"}
            </Text>
            <Text style={s.stackTitle} numberOfLines={1}>
              {a[0].title}
            </Text>
            <Text style={s.stackSub}>{dateText(a[0].event_date)}</Text>
          </Pressable>
        ))}
      </View>
      <Modal
        visible={!!album}
        animationType="slide"
        onRequestClose={() => (big !== null ? setBig(null) : setAlbum(null))}
      >
        {album && (
          <View style={s.albumWrap}>
            <View style={s.row}>
              <Text style={[s.heading, { flex: 1 }]}>
                {album[0].title}
                {big !== null ? " · " + (big + 1) + " of " + album.length : ""}
              </Text>
              <Pressable
                onPress={() => (big !== null ? setBig(null) : setAlbum(null))}
              >
                <Text style={s.link}>{big !== null ? "All photos" : "Close"}</Text>
              </Pressable>
            </View>
            {big === null ? (
              <ScrollView contentContainerStyle={s.albumGrid}>
                {album.map((p, k) => (
                  <Pressable key={p.id} onPress={() => setBig(k)}>
                    <Image source={src(p.id)} style={s.albumThumb} />
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <View style={{ flex: 1, gap: 12 }}>
                <Image
                  source={src(album[big].id)}
                  style={{ flex: 1 }}
                  resizeMode="contain"
                />
                {album.length > 1 && (
                  <View style={s.tabsRow}>
                    <Btn
                      title="← Previous"
                      secondary
                      onPress={() => setBig((big + album.length - 1) % album.length)}
                    />
                    <Btn
                      title="Next →"
                      secondary
                      onPress={() => setBig((big + 1) % album.length)}
                    />
                  </View>
                )}
              </View>
            )}
          </View>
        )}
      </Modal>
    </View>
  );
}

// ---- profile sections: personal, medical, nominees, insurance ------------------------------------
type Details = {
  personal: Record<string, string | number | null>;
  medical: Record<string, string | null>;
  nominees: { name: string; relation: string | null; share: number }[];
  insurance: {
    type: string;
    provider: string | null;
    policy_no: string | null;
    sum_insured: number | null;
    valid_till: string | null;
  }[];
};
const MARITAL: Record<string, string> = {
  single: "Single",
  married: "Married",
  divorced: "Divorced",
  widowed: "Widowed",
};
function DetailsCards({ api }: { api: Api }) {
  const d = useLoad(() => api<Details>("/profile/details"));
  const [edit, setEdit] = useState<"personal" | "medical" | "nominees" | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const start = (which: "personal" | "medical" | "nominees") => {
    const x = d.data!;
    setForm(
      which === "nominees"
        ? {
            list: x.nominees
              .map((n) => [n.name, n.relation ?? "", n.share].join(", "))
              .join("\n"),
          }
        : Object.fromEntries(
            Object.entries(x[which]).map(([k, v]) => [k, v == null ? "" : String(v)]),
          ),
    );
    setEdit(which);
  };
  const save = async () => {
    const body =
      edit === "nominees"
        ? {
            nominees: (form.list ?? "")
              .split("\n")
              .map((l) => l.split(",").map((x) => x.trim()))
              .filter((x) => x[0])
              .map(([name, relation, share]) => ({
                name,
                relation: relation || null,
                share: Number(share || 100),
              })),
          }
        : edit === "personal"
          ? {
              personal: {
                ...form,
                children: form.children ? Number(form.children) : null,
              },
            }
          : { medical: form };
    if (await attempt(() => api("/profile/details", body, "PUT"), "Saved.")) {
      setEdit(null);
      void d.reload();
    }
  };
  const row = (label: string, value: unknown) => (
    <View key={label} style={s.row}>
      <Text style={s.note}>{label}</Text>
      <Text style={s.strong}>{value == null || value === "" ? "—" : String(value)}</Text>
    </View>
  );
  if (!d.data) return <Status loading={d.loading} error={d.error} />;
  const x = d.data;
  if (edit)
    return (
      <View style={s.card}>
        <Text style={s.heading}>
          {edit === "personal"
            ? "Personal information"
            : edit === "medical"
              ? "Medical information"
              : "Nominees"}
        </Text>
        {edit === "personal" && (
          <>
            <Field label="Father's name" value={form.father_name ?? ""} onChange={set("father_name")} />
            <Text style={s.label}>Blood group</Text>
            <View style={s.wrap}>
              {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((b) => (
                <Pressable
                  key={b}
                  onPress={() => set("blood_group")(b)}
                  style={[s.chip, form.blood_group === b && s.chipOn]}
                >
                  <Text style={[s.chipText, form.blood_group === b && { color: "#fff" }]}>{b}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={s.label}>Marital status</Text>
            <View style={s.wrap}>
              {Object.entries(MARITAL).map(([k, v]) => (
                <Pressable
                  key={k}
                  onPress={() => set("marital_status")(k)}
                  style={[s.chip, form.marital_status === k && s.chipOn]}
                >
                  <Text style={[s.chipText, form.marital_status === k && { color: "#fff" }]}>{v}</Text>
                </Pressable>
              ))}
            </View>
            <Field label="Number of children" value={form.children ?? ""} onChange={set("children")} keyboardType="numeric" />
            <Field label="Nationality" value={form.nationality ?? ""} onChange={set("nationality")} />
            <Field label="Personal email" value={form.personal_email ?? ""} onChange={set("personal_email")} keyboardType="email-address" />
          </>
        )}
        {edit === "medical" && (
          <>
            <Field label="Allergies" value={form.allergies ?? ""} onChange={set("allergies")} />
            <Field label="Medical conditions" value={form.conditions ?? ""} onChange={set("conditions")} />
            <Field label="Family doctor and phone" value={form.doctor ?? ""} onChange={set("doctor")} />
          </>
        )}
        {edit === "nominees" && (
          <Field
            label="One per line: name, relation, share % (shares add up to 100)"
            value={form.list ?? ""}
            onChange={set("list")}
            multiline
            placeholder="Sunita Devi, Mother, 100"
          />
        )}
        <Btn title="Save" onPress={() => void save()} />
        <Btn title="Cancel" secondary onPress={() => setEdit(null)} />
      </View>
    );
  return (
    <>
      <View style={s.card}>
        <Text style={s.heading}>Personal information</Text>
        {row("Father's name", x.personal.father_name)}
        {row("Blood group", x.personal.blood_group)}
        {row("Marital status", MARITAL[String(x.personal.marital_status)] ?? null)}
        {row("Children", x.personal.children)}
        {row("Nationality", x.personal.nationality)}
        {row("Personal email", x.personal.personal_email)}
        <Btn title="Edit" secondary onPress={() => start("personal")} />
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Medical information</Text>
        {row("Allergies", x.medical.allergies)}
        {row("Medical conditions", x.medical.conditions)}
        {row("Family doctor", x.medical.doctor)}
        <Btn title="Edit" secondary onPress={() => start("medical")} />
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Nominees</Text>
        {x.nominees.length === 0 && (
          <Text style={s.note}>No nominees recorded.</Text>
        )}
        {x.nominees.map((n, i) => row(n.name + (n.relation ? " · " + n.relation : ""), n.share + "%"))}
        <Btn title="Edit" secondary onPress={() => start("nominees")} />
      </View>
      <View style={s.card}>
        <Text style={s.heading}>Insurance</Text>
        {x.insurance.length === 0 && (
          <Text style={s.note}>HR records the insurance cover provided to you.</Text>
        )}
        {x.insurance.map((p, i) =>
          row(
            (p.provider ?? "Policy") + " · " + p.type,
            [p.sum_insured ? inr(p.sum_insured) : null, p.valid_till ? "till " + dateText(p.valid_till) : null]
              .filter(Boolean)
              .join(" · "),
          ),
        )}
      </View>
    </>
  );
}

// ---- payslips -------------------------------------------------------------------------------
function PayslipsScreen({ api, files }: { api: Api; files: Files }) {
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
    <>
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
    <Form16Card api={api} files={files} />
    </>
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

// ---- on-duty log: the days marked on duty and how each was decided ------------------------
function OdLogScreen({ api }: { api: Api }) {
  const list = useLoad(() => api<Correction[]>("/regularizations"));
  const rows = (list.data ?? []).filter((r) => r.kind === "on_duty");
  return (
    <View style={s.card}>
      <Text style={s.heading}>OD Log History</Text>
      <Text style={s.note}>
        Days you were on duty away from your workplace. Ask for one under
        Regularization.
      </Text>
      <Status loading={list.loading} error={list.error} />
      {!list.loading && rows.length === 0 && (
        <Text style={s.note}>No on-duty days yet.</Text>
      )}
      {rows.map((r) => (
        <View key={r.id} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.strong}>{dateText(r.date)}</Text>
            <Text style={s.note}>{r.reason}</Text>
          </View>
          <Pill text={r.status} />
        </View>
      ))}
    </View>
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
            <Text style={[s.strong, !n.read_at && { color: "#4e5aa8" }]}>
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
// My profile with its extra sections underneath.
function ProfileWithDetails(props: {
  api: Api;
  onSignOut: () => void;
  onPassword: () => void;
}) {
  return (
    <>
      <ProfileScreen {...props} />
      <DetailsCards api={props.api} />
    </>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eceaf1",
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  heading: {
    color: "#2a2c3a",
    fontSize: 21,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  label: { fontSize: 12, fontWeight: "600", color: "#555867" },
  input: {
    backgroundColor: "#fafafc",
    borderColor: "#e1e0e8",
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    color: "#2a2c3a",
    fontSize: 15,
  },
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    backgroundColor: "#4e5aa8",
    borderRadius: 12,
    alignItems: "center",
  },
  btnSecondary: { backgroundColor: "#eceefa" },
  btnText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: "#eceefa",
  },
  chipOn: { backgroundColor: "#4e5aa8" },
  chipText: { color: "#4e5aa8", fontWeight: "600", fontSize: 13 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "#f0eff4",
  },
  strong: { fontWeight: "600", color: "#3a3c4a", fontSize: 14 },
  note: { color: "#7a7d8c", fontSize: 12, lineHeight: 18 },
  link: { color: "#4e5aa8", fontWeight: "600", fontSize: 13 },
  error: {
    color: "#894a35",
    backgroundColor: "#f9eae3",
    padding: 12,
    borderRadius: 10,
  },
  pill: {
    backgroundColor: "#eceefa",
    color: "#4e5aa8",
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
    backgroundColor: "#ac051b",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  netLabel: { color: "#fde7ea", fontWeight: "600" },
  netValue: { color: "#fff", fontSize: 22, fontWeight: "700" },
  bubble: { backgroundColor: "#f3f2f7", borderRadius: 12, padding: 12, gap: 4 },
  hero: {
    backgroundColor: "#ac051b",
    borderRadius: 24,
    padding: 18,
    gap: 16,
    overflow: "hidden",
  },
  heroBlob: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#4e5aa8",
    opacity: 0.55,
    right: -70,
    top: -90,
  },
  heroBlob2: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: "#ff6b81",
    opacity: 0.25,
    left: -50,
    bottom: -60,
  },
  timeBox: {
    alignSelf: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 22,
  },
  timeLabel: { color: "#fde7ea", fontSize: 13, letterSpacing: 1 },
  timeValue: { color: "#fff", fontSize: 34, fontWeight: "800" },
  punchBtn: {
    height: 56,
    borderRadius: 28,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  punchBtnText: { color: "#ac051b", fontWeight: "800", fontSize: 17, letterSpacing: 0.5 },
  odBtn: {
    height: 46,
    borderRadius: 23,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  odBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  tiles: { flexDirection: "row", gap: 12 },
  tile: { flex: 1, borderRadius: 14, padding: 14, gap: 2 },
  tileLabel: { color: "#fff", fontWeight: "700", fontSize: 12 },
  tileValue: { color: "#fff", fontWeight: "800", fontSize: 22 },
  galleryCard: { backgroundColor: "#171a28", borderColor: "#2b2f45" },
  galleryKicker: {
    color: "#ff6b81",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 3,
  },
  stacks: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 22,
    paddingVertical: 10,
  },
  stack: { width: 140, alignItems: "center" },
  stackPhoto: {
    position: "absolute",
    top: 0,
    width: 120,
    height: 120,
    borderRadius: 4,
    borderWidth: 6,
    borderColor: "#f4f4f8",
    backgroundColor: "#f4f4f8",
  },
  stackCount: {
    marginTop: 128,
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    backgroundColor: "#4e5aa8",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  stackTitle: { color: "#eef0ff", fontWeight: "700", fontSize: 13, marginTop: 4 },
  stackSub: { color: "#b9bdd6", fontSize: 11 },
  albumWrap: { flex: 1, padding: 18, paddingTop: 48, gap: 12, backgroundColor: "#fff" },
  albumGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  albumThumb: { width: 104, height: 104, borderRadius: 8, backgroundColor: "#eee" },
  tabsRow: { flexDirection: "row", gap: 10, justifyContent: "center" },
  crumb: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontWeight: "600",
    color: "#2a2c3a",
  },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  applied: {
    backgroundColor: "#f1f1f4",
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 9,
    fontSize: 12,
    color: "#3a3c4a",
    overflow: "hidden",
  },
  feed: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: "#f0eff4",
    gap: 3,
  },
  feedTitle: { color: "#1d6fd6", fontWeight: "700", fontSize: 14 },
  orgNode: {
    backgroundColor: "#d9ecf7",
    borderColor: "#b9d7ea",
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: "center",
    minWidth: 140,
  },
  orgMe: { backgroundColor: "#fde7ea", borderColor: "#f3b8c0" },
  orgLine: { width: 1, height: 14, backgroundColor: "#b9b9c6" },
  clock: {
    fontSize: 28,
    fontWeight: "700",
    color: "#2a2c3a",
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  msg: { maxWidth: "90%", alignSelf: "flex-start" },
  msgMine: { alignSelf: "flex-end", backgroundColor: "#e3e6f8" },
  body: { color: "#2a2c3a", fontSize: 15, lineHeight: 21 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#eceefa",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#4e5aa8", fontWeight: "700", fontSize: 13 },
  count: {
    backgroundColor: "#4e5aa8",
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    minWidth: 22,
    textAlign: "center",
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 11,
    overflow: "hidden",
  },
  draft: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#eceaf1",
    padding: 12,
    gap: 10,
    marginTop: 4,
  },
  callout: {
    color: "#4e5aa8",
    backgroundColor: "#eceefa",
    padding: 12,
    borderRadius: 10,
    overflow: "hidden",
  },
});
