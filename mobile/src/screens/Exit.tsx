import React, { useState } from "react";
import { Text, View } from "react-native";
import {
  type Api,
  Btn,
  Field,
  Pill,
  Status,
  attempt,
  dateText,
  isDate,
  k,
  today,
  useLoad,
} from "./kit";

// Resigning from the phone: the notice period, the request, and its progress. HR decides
// the last working day; a pending resignation can be withdrawn.
type Exit = {
  id: number;
  kind: string;
  status: string;
  notice_given_on: string;
  requested_last_day: string | null;
  last_working_day: string | null;
  reason: string | null;
  decision_note: string | null;
  initiated_by: string;
};
const STATUS: Record<string, string> = {
  pending: "Waiting for HR",
  accepted: "Accepted",
  rejected: "Not accepted",
  withdrawn: "Withdrawn",
  completed: "Completed",
};

export function ResignationScreen({ api }: { api: Api }) {
  const mine = useLoad(() =>
    api<{ exit: Exit | null; notice_days: number }>("/exit/mine"),
  );
  const [writing, setWriting] = useState(false);
  const [reason, setReason] = useState("");
  const [lastDay, setLastDay] = useState("");
  const x = mine.data?.exit;
  const live = x && ["pending", "accepted"].includes(x.status);
  return (
    <View style={k.card}>
      <Text style={k.heading}>Resignation</Text>
      <Status loading={mine.loading} error={mine.error} />
      {x && (
        <View style={k.item}>
          <Pill text={STATUS[x.status] ?? x.status} />
          <Text style={k.strong}>
            {x.kind === "resignation" ? "Resignation" : "Exit"} given on{" "}
            {dateText(x.notice_given_on)}
          </Text>
          {x.last_working_day ? (
            <Text style={k.body}>
              Last working day: {dateText(x.last_working_day)}
            </Text>
          ) : x.requested_last_day ? (
            <Text style={k.note}>
              You asked to leave on {dateText(x.requested_last_day)}
            </Text>
          ) : null}
          {x.reason ? <Text style={k.note}>{x.reason}</Text> : null}
          {x.decision_note ? (
            <Text style={k.note}>HR: {x.decision_note}</Text>
          ) : null}
          {x.status === "pending" && x.initiated_by === "employee" && (
            <Btn
              title="Withdraw resignation"
              secondary
              onPress={() =>
                void attempt(async () => {
                  await api("/exit/withdraw", {});
                  await mine.reload();
                }, "Your resignation was withdrawn.")
              }
            />
          )}
          {x.status === "accepted" && (
            <Text style={k.note}>
              HR will take you through clearance and the full and final
              settlement.
            </Text>
          )}
        </View>
      )}
      {mine.data && !live && !writing && (
        <>
          <Text style={k.note}>
            Your notice period is {mine.data.notice_days} days. HR confirms your
            last working day.
          </Text>
          <Btn title="Resign" secondary onPress={() => setWriting(true)} />
        </>
      )}
      {writing && (
        <View style={{ gap: 10 }}>
          <Field
            label="Preferred last working day (YYYY-MM-DD, optional)"
            value={lastDay}
            onChange={setLastDay}
          />
          <Field label="Reason" value={reason} onChange={setReason} multiline />
          <View style={k.actions}>
            <Btn
              title="Submit resignation"
              disabled={!reason.trim()}
              onPress={() =>
                void attempt(async () => {
                  if (lastDay && (!isDate(lastDay) || lastDay < today()))
                    throw new Error("Write a future date as YYYY-MM-DD.");
                  await api("/exit/resign", {
                    reason: reason.trim(),
                    requested_last_day: lastDay.trim() || undefined,
                  });
                  setWriting(false);
                  await mine.reload();
                }, "Your resignation was sent to HR.")
              }
            />
            <Btn title="Cancel" secondary onPress={() => setWriting(false)} />
          </View>
        </View>
      )}
    </View>
  );
}
