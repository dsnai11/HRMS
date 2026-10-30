import { HttpError, number, oneOf, string } from "./http.js";

// Screening questions on a job, answered on the careers page; a knock-out answer
// rejects the application.
// ---- screening questions ----------------------------------------------------------------------
// [{ id, text, type: yes_no | number | choice, options?, knockout?: { equals } | { min } | { max } }]
export function cleanScreening(list) {
  if (!Array.isArray(list)) throw new HttpError(400, "Screening questions must be a list.");
  if (list.length > 10) throw new HttpError(400, "Up to 10 screening questions.");
  return list.map((q, i) => {
    const type = oneOf(q?.type, `Question ${i + 1} type`, ["yes_no", "number", "choice"]);
    const out = { id: `s${i + 1}`, type, text: string(q.text, `Question ${i + 1}`, 200) };
    if (type === "choice") {
      const options = [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => String(o ?? "").trim()).filter(Boolean))];
      if (options.length < 2 || options.length > 8 || options.some((o) => o.length > 80))
        throw new HttpError(400, `Question ${i + 1}: give 2 to 8 choices.`);
      out.options = options;
    }
    const k = q.knockout;
    if (k && typeof k === "object") {
      if (type === "number") {
        const min = k.min === undefined || k.min === "" || k.min === null ? null : number(Number(k.min), "Knock-out minimum", -1e9, 1e9);
        const max = k.max === undefined || k.max === "" || k.max === null ? null : number(Number(k.max), "Knock-out maximum", -1e9, 1e9);
        if (min !== null || max !== null) out.knockout = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
      } else if (k.equals !== undefined && k.equals !== "") {
        const allowed = type === "yes_no" ? ["yes", "no"] : out.options;
        out.knockout = { equals: oneOf(k.equals, `Question ${i + 1} knock-out answer`, allowed) };
      }
    }
    return out;
  });
}
/** Questions as the careers page shows them: without the knock-out rules. */
export const publicScreening = (list) => list.map(({ knockout, ...q }) => q);

/** Checks the answers; returns them with the questions that knocked the candidate out. */
export function evaluateScreening(questions, given = {}) {
  const answers = {},
    failed = [];
  for (const q of questions) {
    const v = given?.[q.id];
    if (v === undefined || v === null || v === "") throw new HttpError(400, `Answer: ${q.text}`);
    let a;
    if (q.type === "yes_no") a = oneOf(v, q.text, ["yes", "no"]);
    else if (q.type === "number") a = number(Number(v), q.text, -1e9, 1e9);
    else a = oneOf(v, q.text, q.options);
    answers[q.id] = a;
    const k = q.knockout;
    if (!k) continue;
    if ((k.equals !== undefined && a === k.equals) || (k.min !== undefined && a < k.min) || (k.max !== undefined && a > k.max))
      failed.push(q.text);
  }
  return { answers, failed };
}

