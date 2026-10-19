// Plain-text letter bodies, rendered and printed by the portal's letter page.
const inr = (n) =>
  `Rs. ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
const longDate = (d) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));

export function offerLetter({ company, candidate, offer, today }) {
  return {
    title: "Offer of employment",
    date: longDate(today),
    to: candidate.name,
    paragraphs: [
      `Dear ${candidate.name},`,
      `We are pleased to offer you the position of ${offer.designation} at ${company}. This offer is subject to verification of your documents and references.`,
      `Your monthly gross salary will be ${inr(offer.monthly_gross)} (${inr(offer.monthly_gross * 12)} a year), with statutory deductions as applicable. The detailed breakup is shared with your first payslip.`,
      `Your date of joining will be ${longDate(offer.joining_date)}.${offer.valid_until ? ` This offer is valid until ${longDate(offer.valid_until)}.` : ""}`,
      ...(offer.note ? [offer.note] : []),
      "Please confirm your acceptance in the manner communicated by HR. We look forward to welcoming you.",
    ],
    signoff: `For ${company}`,
  };
}

export function exitLetter(kind, { company, person, joined, lastDay, today }) {
  const where = `${person.designation_name ? `${person.designation_name}` : "an employee"}${person.department_name ? `, ${person.department_name}` : ""}`;
  if (kind === "relieving")
    return {
      title: "Relieving letter",
      date: longDate(today),
      to: person.name,
      paragraphs: [
        `This is to confirm that ${person.name} (employee code ${person.employee_code ?? "—"}) was employed with ${company} as ${where} from ${longDate(joined)} and has been relieved from duties at the close of business on ${longDate(lastDay)}.`,
        "All dues have been settled as per the company's records. We thank them for their contribution and wish them well.",
      ],
      signoff: `For ${company}`,
    };
  return {
    title: "Experience certificate",
    date: longDate(today),
    to: "Whom it may concern",
    paragraphs: [
      `This is to certify that ${person.name} (employee code ${person.employee_code ?? "—"}) worked with ${company} as ${where} from ${longDate(joined)} to ${longDate(lastDay)}.`,
      "During this period their conduct was found satisfactory. We wish them success in their future endeavours.",
    ],
    signoff: `For ${company}`,
  };
}
