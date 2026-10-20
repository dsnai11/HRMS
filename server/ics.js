// Minimal RFC 5545 calendar invite for an interview. Opens in Google Calendar, Outlook and Apple Calendar.
const esc = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
const stamp = (d) =>
  new Date(d)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
// Lines longer than 75 octets are folded with CRLF + space.
const fold = (line) => {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 75;
    while (Buffer.byteLength(rest.slice(0, n)) > 75) n--;
    out.push(rest.slice(0, n));
    rest = " " + rest.slice(n);
  }
  out.push(rest);
  return out.join("\r\n");
};

export function interviewIcs({
  uid,
  start,
  minutes = 60,
  summary,
  description,
  location,
  organizer,
  now = Date.now(),
}) {
  const end = new Date(Date.parse(start) + minutes * 60000);
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//HRMS//Interview//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(summary)}`,
      description ? `DESCRIPTION:${esc(description)}` : null,
      location ? `LOCATION:${esc(location)}` : null,
      organizer
        ? `ORGANIZER;CN=${esc(organizer)}:mailto:noreply@invalid`
        : null,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}

export const googleCalendarLink = ({
  start,
  minutes = 60,
  summary,
  description,
  location,
}) =>
  "https://calendar.google.com/calendar/render?" +
  new URLSearchParams({
    action: "TEMPLATE",
    text: summary,
    dates: `${stamp(start)}/${stamp(Date.parse(start) + minutes * 60000)}`,
    details: description ?? "",
    location: location ?? "",
  });
