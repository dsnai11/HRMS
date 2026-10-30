import React, { useState } from "react";
import { Alert, Linking, Text, View } from "react-native";
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
  k,
  timeText,
  useLoad,
} from "./kit";

// Performance (goals, mid-year and year-end reviews with core competencies) and learning
// (courses with lessons and a quiz, tracked training, classroom sessions).
type Goal = {
  id: number;
  title: string;
  description: string | null;
  weight: number;
  progress: number;
  status: string;
  due_date: string | null;
};
type Review = {
  id: number;
  cycle_name: string;
  phase: "mid_year" | "year_end";
  status: string;
  cycle_status: string;
  self_rating: number | null;
  self_comment: string | null;
  manager_rating: number | null;
  manager_comment: string | null;
  employee_name?: string;
};
type Competency = {
  competency_id: number;
  name: string;
  description: string | null;
  self_rating: number | null;
  manager_rating: number | null;
  manager_comment: string | null;
};
const PHASE = {
  mid_year: "Mid-year check-in",
  year_end: "Year-end evaluation",
};
const REVIEW_STATUS: Record<string, string> = {
  pending_self: "Waiting for self-review",
  pending_manager: "Waiting for manager",
  completed: "Complete",
};
const STARS: [number, string][] = [1, 2, 3, 4, 5].map((n) => [n, String(n)]);

function Goals({ api }: { api: Api }) {
  const goals = useLoad(() => api<Goal[]>("/goals"));
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [weight, setWeight] = useState("20");
  const [history, setHistory] = useState<{
    title: string;
    changes: {
      field: string;
      old_value: string | null;
      new_value: string | null;
      changed_at: string;
      changed_by_name: string;
    }[];
  } | null>(null);
  if (history)
    return (
      <View style={k.card}>
        <Text style={k.heading}>Changes · {history.title}</Text>
        {history.changes.length === 0 && (
          <Empty text="Not changed since it was set." />
        )}
        {history.changes.map((c, i) => (
          <View key={i} style={k.item}>
            <Text style={k.strong}>
              {c.field}: {c.old_value ?? "—"} → {c.new_value ?? "—"}
            </Text>
            <Text style={k.note}>
              {c.changed_by_name} · {timeText(c.changed_at)}
            </Text>
          </View>
        ))}
        <Btn title="Back" secondary onPress={() => setHistory(null)} />
      </View>
    );
  return (
    <View style={k.card}>
      <Text style={k.heading}>My goals</Text>
      <Status loading={goals.loading} error={goals.error} />
      {goals.data?.length === 0 && (
        <Empty text="Add a goal, or ask your manager to set some." />
      )}
      {goals.data?.map((g) => (
        <View key={g.id} style={k.item}>
          <View style={k.row}>
            <Text style={[k.strong, { flex: 1 }]}>{g.title}</Text>
            <Pill
              text={
                g.status === "done"
                  ? "Done"
                  : g.status === "dropped"
                    ? "Dropped"
                    : `${g.progress}%`
              }
            />
          </View>
          <Text style={k.note}>
            Weight {g.weight}%
            {g.due_date ? ` · due ${dateText(g.due_date)}` : ""}
          </Text>
          <View style={k.actions}>
            {g.status === "active" && (
              <Choice
                options={[0, 25, 50, 75, 100].map(
                  (p) => [p, `${p}%`] as [number, string],
                )}
                value={g.progress}
                onChange={(p) =>
                  void attempt(async () => {
                    await api(`/goals/${g.id}`, { progress: p }, "PATCH");
                    await goals.reload();
                  })
                }
              />
            )}
            <Btn
              title="History"
              secondary
              onPress={() =>
                void attempt(async () => {
                  const h = await api<{ goal: { title: string }; changes: [] }>(
                    `/goals/${g.id}/history`,
                  );
                  setHistory({ title: h.goal.title, changes: h.changes });
                })
              }
            />
          </View>
        </View>
      ))}
      {adding ? (
        <View style={{ gap: 10 }}>
          <Field label="Goal" value={title} onChange={setTitle} />
          <Field
            label="Weight (%)"
            value={weight}
            onChange={setWeight}
            keyboardType="numeric"
          />
          <View style={k.actions}>
            <Btn
              title="Add goal"
              disabled={!title.trim()}
              onPress={() =>
                void attempt(async () => {
                  await api("/goals", {
                    title: title.trim(),
                    weight: Number(weight) || 0,
                  });
                  setAdding(false);
                  setTitle("");
                  await goals.reload();
                })
              }
            />
            <Btn title="Cancel" secondary onPress={() => setAdding(false)} />
          </View>
        </View>
      ) : (
        <Btn title="Add a goal" secondary onPress={() => setAdding(true)} />
      )}
    </View>
  );
}

/** Writing a self-review or a manager's review, with competency ratings. */
function ReviewForm({
  api,
  review,
  side,
  onDone,
}: {
  api: Api;
  review: Review;
  side: "self" | "manager";
  onDone: () => void;
}) {
  const comps = useLoad(() =>
    api<Competency[]>(`/reviews/${review.id}/competencies`),
  );
  const [rating, setRating] = useState<number | null>(
    review.phase === "mid_year" ? null : 3,
  );
  const [comment, setComment] = useState("");
  const [ratings, setRatings] = useState<Record<number, number>>({});
  return (
    <View style={k.card}>
      <Text style={k.heading}>
        {side === "self"
          ? review.phase === "mid_year"
            ? "Mid-year check-in"
            : "Self-review"
          : `Review of ${review.employee_name}`}
      </Text>
      <Text style={k.note}>{review.cycle_name}</Text>
      {side === "manager" && review.self_comment ? (
        <Text style={k.body}>
          Their view{review.self_rating ? ` (${review.self_rating}/5)` : ""}:{" "}
          {review.self_comment}
        </Text>
      ) : null}
      <Choice
        label={
          review.phase === "mid_year"
            ? "Overall rating (optional at mid-year)"
            : "Overall rating (5 is best)"
        }
        options={STARS}
        value={rating}
        onChange={setRating}
      />
      <Field
        label={
          side === "self"
            ? review.phase === "mid_year"
              ? "Progress so far, and help you need"
              : "How did the period go?"
            : "Your assessment"
        }
        value={comment}
        onChange={setComment}
        multiline
      />
      <Status loading={comps.loading} error={comps.error} />
      {(comps.data ?? []).length > 0 && (
        <Text style={k.sub}>Core competencies</Text>
      )}
      {comps.data?.map((c) => (
        <Choice
          key={c.competency_id}
          label={`${c.name}${side === "manager" && c.self_rating ? ` · self ${c.self_rating}/5` : ""}`}
          options={STARS}
          value={
            ratings[c.competency_id] ??
            (side === "self" ? c.self_rating : c.manager_rating) ??
            3
          }
          onChange={(v) => setRatings({ ...ratings, [c.competency_id]: v })}
        />
      ))}
      <View style={k.actions}>
        <Btn
          title="Submit"
          disabled={!comment.trim() || (review.phase === "year_end" && !rating)}
          onPress={() =>
            void attempt(
              async () => {
                if (comps.data?.length)
                  await api(
                    `/reviews/${review.id}/competencies`,
                    {
                      ratings: comps.data.map((c) => ({
                        competency_id: c.competency_id,
                        rating:
                          ratings[c.competency_id] ??
                          (side === "self"
                            ? c.self_rating
                            : c.manager_rating) ??
                          3,
                      })),
                    },
                    "PUT",
                  );
                await api(`/reviews/${review.id}/${side}`, {
                  rating: rating ?? undefined,
                  comment: comment.trim(),
                });
                onDone();
              },
              side === "self"
                ? "Sent to your manager."
                : "Review saved. HR will release the result.",
            )
          }
        />
        <Btn title="Cancel" secondary onPress={onDone} />
      </View>
    </View>
  );
}

function Reviews({ api, team }: { api: Api; team: boolean }) {
  const list = useLoad(() =>
    api<Review[]>(team ? "/reviews/team" : "/reviews/mine"),
  );
  const [writing, setWriting] = useState<Review | null>(null);
  const [results, setResults] = useState<{
    review: Review;
    comps: Competency[];
  } | null>(null);
  if (writing)
    return (
      <ReviewForm
        api={api}
        review={writing}
        side={team ? "manager" : "self"}
        onDone={() => {
          setWriting(null);
          void list.reload();
        }}
      />
    );
  if (results)
    return (
      <View style={k.card}>
        <Text style={k.heading}>
          Competencies · {results.review.cycle_name}
        </Text>
        {results.comps.length === 0 && (
          <Empty text="HR has not set core competencies." />
        )}
        {results.comps.map((c) => (
          <View key={c.competency_id} style={k.row}>
            <Text style={[k.strong, { flex: 1 }]}>{c.name}</Text>
            <Text style={k.note}>
              Self {c.self_rating ?? "—"} · Manager {c.manager_rating ?? "—"}
            </Text>
          </View>
        ))}
        <Text style={k.note}>
          Your manager&apos;s ratings appear once HR releases the result.
        </Text>
        <Btn title="Back" secondary onPress={() => setResults(null)} />
      </View>
    );
  return (
    <View style={k.card}>
      <Text style={k.heading}>
        {team ? "Reviews waiting for you" : "My reviews"}
      </Text>
      <Status loading={list.loading} error={list.error} />
      {list.data?.length === 0 && (
        <Empty
          text={
            team
              ? "Self-reviews from your team appear here."
              : "Reviews appear when HR starts a cycle."
          }
        />
      )}
      {list.data?.map((r) => (
        <View key={r.id} style={k.item}>
          <Text style={k.strong}>
            {team ? `${r.employee_name} · ` : ""}
            {r.cycle_name}
          </Text>
          <Text style={k.note}>
            {PHASE[r.phase]} · {REVIEW_STATUS[r.status]}
          </Text>
          {!team && r.manager_comment ? (
            <Text style={k.body}>
              Manager{r.manager_rating ? ` (${r.manager_rating}/5)` : ""}:{" "}
              {r.manager_comment}
            </Text>
          ) : null}
          <View style={k.actions}>
            {((team && r.status === "pending_manager") ||
              (!team && r.status === "pending_self")) &&
              r.cycle_status === "open" && (
                <Btn
                  title={
                    team
                      ? "Review"
                      : r.phase === "mid_year"
                        ? "Write check-in"
                        : "Write self-review"
                  }
                  onPress={() => setWriting(r)}
                />
              )}
            {!team && (
              <Btn
                title="Competencies"
                secondary
                onPress={() =>
                  void attempt(async () =>
                    setResults({
                      review: r,
                      comps: await api<Competency[]>(
                        `/reviews/${r.id}/competencies`,
                      ),
                    }),
                  )
                }
              />
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

export function PerformanceScreen({ api }: { api: Api }) {
  const [tab, setTab] = useState<"goals" | "reviews" | "team">("goals");
  return (
    <View style={{ gap: 14 }}>
      <Tabs
        tabs={[
          ["goals", "Goals"],
          ["reviews", "My reviews"],
          ["team", "Team reviews"],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "goals" && <Goals api={api} />}
      {tab === "reviews" && <Reviews api={api} team={false} />}
      {tab === "team" && <Reviews api={api} team />}
    </View>
  );
}

// ---- learning ---------------------------------------------------------------------------------
type Training = {
  id: number;
  title: string;
  kind: string;
  hours: number;
  mandatory: number | boolean;
  due_date: string | null;
  status: string;
  completed_on: string | null;
  score: number | null;
};
type Course = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  pass_mark: number;
  attempts_left: number | null;
  lessons: {
    id: number;
    title: string;
    kind: "text" | "link" | "video";
    body: string;
    done: boolean;
  }[];
  questions: { id: number; question: string; options: string[] }[];
};
type Session = {
  id: number;
  title: string;
  trainer: string | null;
  venue: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  attendance: string;
};

function CourseView({
  api,
  id,
  onBack,
}: {
  api: Api;
  id: number;
  onBack: () => void;
}) {
  const c = useLoad(() => api<Course>(`/learning/${id}`));
  const [lesson, setLesson] = useState<number | null>(null);
  const [quiz, setQuiz] = useState(false);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const course = c.data;
  const open = course?.lessons.find((l) => l.id === lesson);
  if (open)
    return (
      <View style={k.card}>
        <Text style={k.heading}>{open.title}</Text>
        {open.kind === "text" ? (
          <Text style={k.body}>{open.body}</Text>
        ) : (
          <Btn
            title={open.kind === "video" ? "Watch the video" : "Open the link"}
            secondary
            onPress={() => void Linking.openURL(open.body)}
          />
        )}
        <Btn
          title={open.done ? "Back" : "Mark as read"}
          onPress={() =>
            void attempt(async () => {
              if (!open.done) {
                const r = await api<{ completed: boolean }>(
                  `/learning/${id}/lessons/${open.id}/done`,
                  {},
                );
                if (r.completed) Alert.alert("Course completed.");
              }
              setLesson(null);
              await c.reload();
            })
          }
        />
      </View>
    );
  if (quiz && course)
    return (
      <View style={k.card}>
        <Text style={k.heading}>Quiz · pass mark {course.pass_mark}%</Text>
        {course.questions.map((q, i) => (
          <Choice
            key={q.id}
            label={`${i + 1}. ${q.question}`}
            options={q.options.map((o, j) => [j, o] as [number, string])}
            value={answers[i] ?? null}
            onChange={(v) => setAnswers({ ...answers, [i]: v })}
          />
        ))}
        <View style={k.actions}>
          <Btn
            title="Submit answers"
            disabled={Object.keys(answers).length !== course.questions.length}
            onPress={() =>
              void attempt(async () => {
                const r = await api<{ score: number; passed: boolean }>(
                  `/learning/${id}/quiz`,
                  {
                    answers: course.questions.map((_, i) => answers[i]),
                  },
                );
                setQuiz(false);
                setAnswers({});
                await c.reload();
                Alert.alert(
                  r.passed
                    ? `Passed with ${r.score}%.`
                    : `${r.score}%. Not passed yet.`,
                );
              })
            }
          />
          <Btn title="Back" secondary onPress={() => setQuiz(false)} />
        </View>
      </View>
    );
  return (
    <View style={k.card}>
      <Status loading={c.loading} error={c.error} />
      {course && (
        <>
          <Text style={k.heading}>{course.title}</Text>
          {course.description ? (
            <Text style={k.body}>{course.description}</Text>
          ) : null}
          {course.lessons.map((l, i) => (
            <View key={l.id} style={k.row}>
              <Text style={[k.strong, { flex: 1 }]}>
                {i + 1}. {l.title}
              </Text>
              <Btn
                title={l.done ? "Read ✓" : "Open"}
                secondary
                onPress={() => setLesson(l.id)}
              />
            </View>
          ))}
          {course.status !== "completed" && course.questions.length > 0 && (
            <Btn
              title={`Take the quiz${course.attempts_left != null ? ` (${course.attempts_left} attempts left)` : ""}`}
              disabled={
                course.lessons.some((l) => !l.done) ||
                course.attempts_left === 0
              }
              onPress={() => setQuiz(true)}
            />
          )}
          {course.status === "completed" && <Pill text="Completed" />}
        </>
      )}
      <Btn title="Back" secondary onPress={onBack} />
    </View>
  );
}

export function LearningScreen({ api }: { api: Api }) {
  const data = useLoad(async () => {
    const [trainings, sessions] = await Promise.all([
      api<Training[]>("/trainings/mine"),
      api<{ upcoming: Session[]; past: Session[] }>("/training-sessions/mine"),
    ]);
    return { trainings, sessions };
  });
  const [course, setCourse] = useState<number | null>(null);
  if (course)
    return (
      <CourseView
        api={api}
        id={course}
        onBack={() => {
          setCourse(null);
          void data.reload();
        }}
      />
    );
  const s = data.data?.sessions;
  return (
    <View style={{ gap: 14 }}>
      {s && (s.upcoming.length > 0 || s.past.length > 0) && (
        <View style={k.card}>
          <Text style={k.heading}>Training sessions</Text>
          {s.upcoming.length === 0 && <Empty text="No upcoming sessions." />}
          {[...s.upcoming, ...s.past.slice(0, 10)].map((x) => (
            <View key={x.id} style={k.item}>
              <View style={k.row}>
                <Text style={[k.strong, { flex: 1 }]}>{x.title}</Text>
                <Pill
                  text={
                    x.status === "cancelled"
                      ? "Cancelled"
                      : x.attendance === "attended"
                        ? "Attended"
                        : x.attendance === "absent"
                          ? "Absent"
                          : s.upcoming.includes(x)
                            ? "Invited"
                            : "Held"
                  }
                />
              </View>
              <Text style={k.note}>
                {timeText(x.starts_at)} –{" "}
                {timeText(x.ends_at).split(", ").pop()}
                {x.trainer ? ` · ${x.trainer}` : ""}
              </Text>
              {x.venue ? (
                /^https?:\/\//.test(x.venue) ? (
                  <Text
                    style={k.link}
                    onPress={() => void Linking.openURL(x.venue!)}
                  >
                    Join link
                  </Text>
                ) : (
                  <Text style={k.body}>{x.venue}</Text>
                )
              ) : null}
            </View>
          ))}
        </View>
      )}
      <View style={k.card}>
        <Text style={k.heading}>My learning</Text>
        <Status loading={data.loading} error={data.error} />
        {data.data?.trainings.length === 0 && (
          <Empty text="Courses assigned to you appear here." />
        )}
        {data.data?.trainings.map((t) => (
          <View key={t.id} style={k.item}>
            <View style={k.row}>
              <Text style={[k.strong, { flex: 1 }]}>
                {t.title}
                {t.mandatory ? " · mandatory" : ""}
              </Text>
              <Pill
                text={
                  t.status === "completed"
                    ? `Done${t.score != null ? ` · ${t.score}%` : ""}`
                    : t.due_date
                      ? `Due ${dateText(t.due_date)}`
                      : "To do"
                }
              />
            </View>
            <Text style={k.note}>
              {t.kind === "course" ? "Course" : "Training"} · {t.hours} h
            </Text>
            {t.kind === "course" ? (
              <Btn
                title={
                  t.status === "completed" ? "Review course" : "Open course"
                }
                secondary
                onPress={() => setCourse(t.id)}
              />
            ) : t.status === "assigned" && !t.mandatory ? (
              <Btn
                title="Mark done"
                secondary
                onPress={() =>
                  void attempt(async () => {
                    await api(`/trainings/records/${t.id}/complete`, {});
                    await data.reload();
                  })
                }
              />
            ) : t.status === "assigned" ? (
              <Text style={k.note}>Confirmed by your manager or HR.</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
