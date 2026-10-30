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
  attempt,
  dateText,
  inr,
  isDate,
  k,
  pickAndUpload,
  today,
  useLoad,
} from "./kit";

// Reimbursement claims, the yearly tax declaration and bills against bill-backed salary
// components. Form 16 is on the Payslips screen.
type ClaimType = { id: number; name: string; annual_limit: number | null };
type Claim = {
  id: number;
  type_name: string;
  expense_date: string;
  amount: number;
  approved_amount: number | null;
  description: string;
  status: string;
  decision_note: string | null;
};
const CLAIM_STATUS: Record<string, string> = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
  cancelled: "Withdrawn",
};

export function ClaimsScreen({ api }: { api: Api }) {
  const data = useLoad(async () => {
    const [types, claims] = await Promise.all([
      api<ClaimType[]>("/claim-types"),
      api<Claim[]>("/claims"),
    ]);
    return { types, claims };
  });
  const [adding, setAdding] = useState(false);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  if (adding && data.data)
    return (
      <View style={k.card}>
        <Text style={k.heading}>New claim</Text>
        <Choice
          label="Type"
          options={data.data.types.map(
            (t) => [t.id, t.name] as [number, string],
          )}
          value={typeId}
          onChange={setTypeId}
        />
        {typeId &&
        data.data.types.find((t) => t.id === typeId)?.annual_limit ? (
          <Text style={k.note}>
            Yearly limit{" "}
            {inr(data.data.types.find((t) => t.id === typeId)!.annual_limit!)}
          </Text>
        ) : null}
        <Field
          label="Expense date (YYYY-MM-DD)"
          value={date}
          onChange={setDate}
        />
        <Field
          label="Amount (₹)"
          value={amount}
          onChange={setAmount}
          keyboardType="numeric"
        />
        <Field
          label="What it was for"
          value={description}
          onChange={setDescription}
          multiline
        />
        <Field
          label="Bill number (optional)"
          value={reference}
          onChange={setReference}
        />
        <View style={k.actions}>
          <Btn
            title="Submit claim"
            disabled={!typeId || !amount || !description.trim()}
            onPress={() =>
              void attempt(async () => {
                if (!isDate(date))
                  throw new Error("Write the date as YYYY-MM-DD.");
                await api("/claims", {
                  claim_type_id: typeId,
                  expense_date: date.trim(),
                  amount: Number(amount),
                  description: description.trim(),
                  reference: reference.trim() || undefined,
                });
                setAdding(false);
                setAmount("");
                setDescription("");
                setReference("");
                await data.reload();
              }, "Claim submitted.")
            }
          />
          <Btn title="Cancel" secondary onPress={() => setAdding(false)} />
        </View>
      </View>
    );
  return (
    <View style={k.card}>
      <Text style={k.heading}>My claims</Text>
      <Status loading={data.loading} error={data.error} />
      {data.data?.claims.length === 0 && (
        <Empty text="You have not made any claims." />
      )}
      {data.data?.claims.map((c) => (
        <View key={c.id} style={k.item}>
          <View style={k.row}>
            <Text style={k.strong}>
              {c.type_name} · {inr(c.amount)}
            </Text>
            <Pill text={CLAIM_STATUS[c.status] ?? c.status} />
          </View>
          <Text style={k.note}>
            {dateText(c.expense_date)} · {c.description}
            {c.approved_amount != null && c.approved_amount < c.amount
              ? ` · ${inr(c.approved_amount)} approved`
              : ""}
            {c.decision_note ? ` · ${c.decision_note}` : ""}
          </Text>
          {c.status === "pending" && (
            <Btn
              title="Withdraw"
              secondary
              onPress={() =>
                void attempt(async () => {
                  await api(`/claims/${c.id}`, undefined, "DELETE");
                  await data.reload();
                })
              }
            />
          )}
        </View>
      ))}
      <Btn
        title="New claim"
        onPress={() => setAdding(true)}
        disabled={!data.data?.types.length}
      />
      {data.data && !data.data.types.length && (
        <Empty text="Your company has not set up claim types yet." />
      )}
    </View>
  );
}

// ---- tax declaration ------------------------------------------------------------------------
type Section = { key: string; label: string; cap: number | null };
type Item = {
  section: string;
  description: string | null;
  amount: number;
  document_id: number | null;
  status?: string;
  verified_amount?: number | null;
};
type Declaration = {
  label: string;
  open: boolean;
  editable: boolean;
  declaration: {
    status: string;
    regime: "old" | "new";
    review_note: string | null;
  } | null;
  items: Item[];
  allowed: { total: number };
  sections: Section[];
  comparison: { old: number; new: number } | null;
};
const DECL_STATUS: Record<string, string> = {
  draft: "Draft",
  submitted: "With payroll",
  verified: "Verified",
  changes_requested: "Changes needed",
};
type BillSummary = {
  label: string;
  components: {
    id: number;
    name: string;
    monthly: number;
    yearly: number;
    verified: number;
    pending: number;
    exempt: number;
  }[];
  bills: {
    id: number;
    component_name: string;
    bill_date: string;
    bill_no: string | null;
    amount: number;
    verified_amount: number | null;
    description: string;
    status: string;
    note: string | null;
  }[];
};
const BILL_STATUS: Record<string, string> = {
  pending: "With payroll",
  verified: "Verified",
  rejected: "Not accepted",
  cancelled: "Withdrawn",
};

function DeclarationCard({ api }: { api: Api }) {
  const d = useLoad(() => api<Declaration>("/tax-declaration"));
  const [editing, setEditing] = useState(false);
  const [regime, setRegime] = useState<"old" | "new">("new");
  const [items, setItems] = useState<Item[]>([]);
  const [section, setSection] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [proof, setProof] = useState<number | null>(null);
  const label = (key: string) =>
    d.data?.sections.find((s) => s.key === key)?.label ?? key;
  if (editing && d.data)
    return (
      <View style={k.card}>
        <Text style={k.heading}>Investment declaration · {d.data.label}</Text>
        <Choice
          label="Tax regime"
          options={[
            ["new", "New (no deductions)"],
            ["old", "Old (with deductions)"],
          ]}
          value={regime}
          onChange={setRegime}
        />
        {items.map((it, i) => (
          <View key={i} style={k.row}>
            <View style={{ flex: 1 }}>
              <Text style={k.strong}>
                {label(it.section)} · {inr(it.amount)}
              </Text>
              <Text style={k.note}>
                {it.description || ""}
                {it.document_id ? " · proof attached" : ""}
              </Text>
            </View>
            <Btn
              title="Remove"
              secondary
              onPress={() => setItems(items.filter((_, j) => j !== i))}
            />
          </View>
        ))}
        <Text style={k.sub}>Add an item</Text>
        <Choice
          options={d.data.sections.map(
            (s) => [s.key, s.key] as [string, string],
          )}
          value={section}
          onChange={setSection}
        />
        {section ? <Text style={k.note}>{label(section)}</Text> : null}
        <Field
          label="Amount (₹)"
          value={amount}
          onChange={setAmount}
          keyboardType="numeric"
        />
        <Field label="Details (optional)" value={desc} onChange={setDesc} />
        <View style={k.actions}>
          <Btn
            title={proof ? "Proof attached ✓" : "Attach proof"}
            secondary
            onPress={() =>
              void attempt(async () => {
                const id = await pickAndUpload(
                  api,
                  `Tax proof ${section ?? ""}`,
                );
                if (id) setProof(id);
              })
            }
          />
          <Btn
            title="Add item"
            disabled={!section || !amount}
            onPress={() => {
              setItems([
                ...items,
                {
                  section: section!,
                  amount: Number(amount),
                  description: desc.trim() || null,
                  document_id: proof,
                },
              ]);
              setAmount("");
              setDesc("");
              setProof(null);
            }}
          />
        </View>
        <View style={k.actions}>
          <Btn
            title="Save"
            onPress={() =>
              void attempt(async () => {
                await api(
                  "/tax-declaration",
                  {
                    regime,
                    items: items.map((it) => ({
                      section: it.section,
                      amount: it.amount,
                      description: it.description || undefined,
                      document_id: it.document_id ?? undefined,
                    })),
                  },
                  "PUT",
                );
                setEditing(false);
                await d.reload();
              }, "Saved. Submit it to payroll when you are ready.")
            }
          />
          <Btn title="Cancel" secondary onPress={() => setEditing(false)} />
        </View>
      </View>
    );
  const x = d.data;
  return (
    <View style={k.card}>
      <Text style={k.heading}>Tax declaration{x ? ` · ${x.label}` : ""}</Text>
      <Status loading={d.loading} error={d.error} />
      {x && (
        <>
          <Text style={k.note}>
            {x.declaration
              ? `${DECL_STATUS[x.declaration.status]} · ${x.declaration.regime} regime · counted ${inr(x.allowed.total)}`
              : "Not declared yet."}
            {x.open ? "" : " Declarations are closed for now."}
          </Text>
          {x.declaration?.review_note ? (
            <Text style={k.error}>{x.declaration.review_note}</Text>
          ) : null}
          {x.comparison ? (
            <Text style={k.note}>
              Estimated yearly tax: old regime {inr(x.comparison.old)}, new
              regime {inr(x.comparison.new)}
            </Text>
          ) : null}
          {x.items.map((it, i) => (
            <View key={i} style={k.row}>
              <Text style={[k.strong, { flex: 1 }]}>{label(it.section)}</Text>
              <Text>
                {inr(it.amount)}
                {it.status === "verified"
                  ? " ✓"
                  : it.status === "rejected"
                    ? " ✗"
                    : ""}
              </Text>
            </View>
          ))}
          {x.editable && (
            <View style={k.actions}>
              <Btn
                title={x.declaration ? "Edit" : "Declare"}
                secondary={Boolean(x.declaration)}
                onPress={() => {
                  setRegime(x.declaration?.regime ?? "new");
                  setItems(x.items.map((it) => ({ ...it })));
                  setSection(null);
                  setEditing(true);
                }}
              />
              {x.declaration && (
                <Btn
                  title="Submit to payroll"
                  onPress={() =>
                    void attempt(async () => {
                      await api("/tax-declaration/submit", {});
                      await d.reload();
                    }, "Submitted to payroll.")
                  }
                />
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function BillsCard({ api }: { api: Api }) {
  const b = useLoad(() => api<BillSummary>("/salary-bills"));
  const [adding, setAdding] = useState(false);
  const [componentId, setComponentId] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [billNo, setBillNo] = useState("");
  const [desc, setDesc] = useState("");
  const [proof, setProof] = useState<number | null>(null);
  if (!b.loading && !b.error && !b.data?.components.length) return null;
  return (
    <View style={k.card}>
      <Text style={k.heading}>
        Reimbursement bills{b.data ? ` · ${b.data.label}` : ""}
      </Text>
      <Text style={k.note}>
        These parts of your salary are tax-free up to the bills payroll
        verifies, at most a year&apos;s worth.
      </Text>
      <Status loading={b.loading} error={b.error} />
      {b.data?.components.map((c) => (
        <View key={c.id} style={k.row}>
          <View style={{ flex: 1 }}>
            <Text style={k.strong}>{c.name}</Text>
            <Text style={k.note}>
              Up to {inr(c.yearly)} a year
              {c.pending ? ` · ${inr(c.pending)} waiting` : ""}
            </Text>
          </View>
          <Text style={k.strong}>{inr(c.exempt)} tax-free</Text>
        </View>
      ))}
      {adding && b.data ? (
        <View style={{ gap: 10 }}>
          <Choice
            label="For"
            options={b.data.components.map(
              (c) => [c.id, c.name] as [number, string],
            )}
            value={componentId}
            onChange={setComponentId}
          />
          <Field
            label="Bill date (YYYY-MM-DD)"
            value={date}
            onChange={setDate}
          />
          <Field
            label="Amount (₹)"
            value={amount}
            onChange={setAmount}
            keyboardType="numeric"
          />
          <Field
            label="Bill number (optional)"
            value={billNo}
            onChange={setBillNo}
          />
          <Field label="What it is for" value={desc} onChange={setDesc} />
          <View style={k.actions}>
            <Btn
              title={proof ? "Copy attached ✓" : "Attach bill copy"}
              secondary
              onPress={() =>
                void attempt(async () => {
                  const id = await pickAndUpload(api, `Bill ${date}`);
                  if (id) setProof(id);
                })
              }
            />
            <Btn
              title="Add bill"
              disabled={!componentId || !amount || !desc.trim()}
              onPress={() =>
                void attempt(async () => {
                  if (!isDate(date))
                    throw new Error("Write the date as YYYY-MM-DD.");
                  await api("/salary-bills", {
                    component_id: componentId,
                    bill_date: date.trim(),
                    amount: Number(amount),
                    bill_no: billNo.trim() || undefined,
                    description: desc.trim(),
                    document_id: proof ?? undefined,
                  });
                  setAdding(false);
                  setAmount("");
                  setBillNo("");
                  setDesc("");
                  setProof(null);
                  await b.reload();
                }, "Bill added. Payroll will verify it.")
              }
            />
            <Btn title="Cancel" secondary onPress={() => setAdding(false)} />
          </View>
        </View>
      ) : (
        <Btn title="Add a bill" onPress={() => setAdding(true)} />
      )}
      {b.data?.bills.map((x) => (
        <View key={x.id} style={k.item}>
          <View style={k.row}>
            <Text style={k.strong}>
              {x.component_name} · {inr(x.amount)}
            </Text>
            <Pill text={BILL_STATUS[x.status] ?? x.status} />
          </View>
          <Text style={k.note}>
            {dateText(x.bill_date)}
            {x.bill_no ? ` · ${x.bill_no}` : ""} · {x.description}
            {x.status === "verified" &&
            x.verified_amount != null &&
            x.verified_amount < x.amount
              ? ` · ${inr(x.verified_amount)} accepted`
              : ""}
            {x.note ? ` · ${x.note}` : ""}
          </Text>
          {x.status === "pending" && (
            <Btn
              title="Withdraw"
              secondary
              onPress={() =>
                void attempt(async () => {
                  await api(`/salary-bills/${x.id}/cancel`, {});
                  await b.reload();
                })
              }
            />
          )}
        </View>
      ))}
    </View>
  );
}

export function TaxScreen({ api }: { api: Api }) {
  return (
    <View style={{ gap: 14 }}>
      <DeclarationCard api={api} />
      <BillsCard api={api} />
    </View>
  );
}
