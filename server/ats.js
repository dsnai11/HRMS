// ATS score: how well a candidate fits an opening's job description, 0–100, with the parts
// that made it up so HR and the department head can see why.
//
// Parts (each counts only when the job and the candidate give something to compare):
//   skills         35  required skills found among the candidate's skills
//   experience     15  years against the minimum asked
//   jd_keywords    25  words from the title, description and qualifications found in the resume
//   qualification  15  the degree asked (or a higher one) in the resume or stated qualification
//   screening      10  knock-out questions answered the right way
// With only skills and experience defined this gives the same 70 : 30 split as before.

const STOP = new Set(
  `about above across after again against also among and any are able based been before being below
  between both but candidate candidates can company could daily data does doing done down during each
  either etc every experience few for from good have having help here into its job just know least
  like look make more most must need needed new not of off once only other our out over own per
  plus preferred required responsible role same should skills some such than that the their them then
  there these they this those through time under until very want well were what when where which
  while who whom why will with within work working would year years you your team strong ability
  knowledge understanding minimum maximum least handling manage managing ensure ensuring including
  related relevant various level levels using use used`.split(/\s+/),
);

// Degrees by level. A higher level satisfies a lower one ("graduate" is met by an MBA).
const DEGREES = [
  [1, ["10th", "ssc", "matric", "high school"]],
  [2, ["12th", "hsc", "intermediate", "higher secondary"]],
  [3, ["diploma", "iti", "polytechnic"]],
  [4, ["graduate", "graduation", "bachelor", "b.com", "bcom", "b com", "bba", "b.sc", "bsc", "b.a", "ba", "bca", "b.tech", "btech", "b.e", "be", "llb"]],
  [5, ["post graduate", "postgraduate", "master", "mba", "pgdm", "m.com", "mcom", "m.sc", "msc", "m.a", "ma", "mca", "m.tech", "mtech"]],
  [5, ["ca", "chartered accountant", "cs", "company secretary", "cma", "icwa", "cfa"]],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^a-z0-9])${esc(word)}($|[^a-z0-9])`).test(text);

/** Highest degree level named in a text (0 when none). */
export function degreeLevel(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  let best = 0;
  for (const [level, words] of DEGREES) if (words.some((w) => has(t, w))) best = Math.max(best, level);
  return best;
}

/** Up to 30 distinct words worth looking for, from the job's title, description and qualifications. */
export function jdKeywords(opening) {
  const text = [opening.title, opening.description, opening.qualifications].filter(Boolean).join(" ").toLowerCase();
  const seen = new Set();
  for (const w of text.match(/[a-z][a-z0-9+#.]{2,}/g) || []) {
    const word = w.replace(/\.+$/, "");
    if (word.length < 3 || STOP.has(word) || /^\d/.test(word)) continue;
    seen.add(word);
    if (seen.size >= 30) break;
  }
  return [...seen];
}

const sameSkill = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)));

/**
 * { score, parts: [{ key, label, weight, got (0–1), detail }] } or null when there is nothing
 * to compare.
 */
export function atsScore(opening, cand) {
  const parts = [];
  const need = JSON.parse(opening.skills || "[]");
  const haveSkills = JSON.parse(cand.skills || "[]");
  const resume = String(cand.resume_text || "").toLowerCase();
  if (need.length) {
    const found = need.filter((n) => haveSkills.some((h) => sameSkill(n, h)) || (resume && has(resume, n)));
    const missing = need.filter((n) => !found.includes(n));
    parts.push({
      key: "skills",
      label: "Skills",
      weight: 35,
      got: found.length / need.length,
      detail: `${found.length} of ${need.length}${missing.length ? ` · missing: ${missing.slice(0, 6).join(", ")}` : ""}`,
    });
  }
  const minExp = Number(opening.min_experience_years) || 0;
  if (minExp > 0) {
    const yrs = Number(cand.experience_years) || 0;
    parts.push({
      key: "experience",
      label: "Experience",
      weight: 15,
      got: Math.min(yrs / minExp, 1),
      detail: `${cand.experience_years == null ? "not given" : `${yrs} yrs`} of ${minExp} asked`,
    });
  }
  const words = jdKeywords(opening);
  if (resume && words.length >= 3) {
    const found = words.filter((w) => has(resume, w));
    parts.push({
      key: "jd_keywords",
      label: "Job description",
      weight: 25,
      got: Math.min(found.length / Math.min(words.length, 15), 1),
      detail: `${found.length} of ${words.length} key words in the resume${found.length ? `: ${found.slice(0, 8).join(", ")}` : ""}`,
    });
  }
  const want = degreeLevel(opening.qualifications);
  if (want) {
    const gotLevel = degreeLevel(`${cand.qualification || ""} ${resume}`);
    parts.push({
      key: "qualification",
      label: "Qualification",
      weight: 15,
      got: gotLevel >= want ? 1 : gotLevel ? 0.5 : 0,
      detail: gotLevel >= want ? "meets what is asked" : gotLevel ? "lower than asked" : "not found",
    });
  }
  const questions = JSON.parse(opening.screening || "[]").filter((q) => q.knockout);
  const screen = cand.screening ? JSON.parse(cand.screening) : null;
  if (questions.length && screen?.answers) {
    const failed = new Set(screen.failed || []);
    const ok = questions.filter((q) => !failed.has(q.text)).length;
    parts.push({
      key: "screening",
      label: "Screening answers",
      weight: 10,
      got: ok / questions.length,
      detail: `${ok} of ${questions.length} as needed`,
    });
  }
  if (!parts.length) return null;
  const weight = parts.reduce((a, p) => a + p.weight, 0);
  const score = Math.round((parts.reduce((a, p) => a + p.weight * p.got, 0) / weight) * 100);
  return { score, parts: parts.map((p) => ({ ...p, got: Math.round(p.got * 100) / 100 })) };
}
