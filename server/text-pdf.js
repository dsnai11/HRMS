// A plain one-page A4 PDF of a text letter (title, date, addressee, paragraphs, sign-off),
// written directly so no PDF library is needed. Text is in the standard Helvetica font,
// which every PDF reader has; characters outside Latin-1 are replaced.
const PAGE = { w: 595, h: 842, margin: 64 };

const latin1 = (s) =>
  String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const escape = (s) => latin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// Helvetica is roughly half a point wide per point of size per character; wrap by that.
function wrap(text, size, width) {
  const max = Math.floor(width / (size * 0.5));
  const lines = [];
  for (const para of latin1(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line ? line.length + 1 : 0) + word.length > max && line) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** { heading, title, date, to, paragraphs, signoff } -> Buffer (application/pdf) */
export function textPdf({ heading, title, date, to, paragraphs = [], signoff }) {
  const width = PAGE.w - PAGE.margin * 2;
  const ops = [];
  let y = PAGE.h - PAGE.margin;
  const put = (text, { size = 11, bold = false, gap = 0 } = {}) => {
    for (const line of wrap(text, size, width)) {
      y -= size * 1.45;
      ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${PAGE.margin} ${y.toFixed(1)} Td (${escape(line)}) Tj ET`);
    }
    y -= gap;
  };
  if (heading) put(heading, { size: 13, bold: true, gap: 18 });
  if (date) put(date, { gap: 10 });
  if (title) put(title, { size: 15, bold: true, gap: 12 });
  if (to) put(to, { gap: 12 });
  for (const p of paragraphs) put(p, { gap: 10 });
  if (signoff) {
    y -= 30;
    put(signoff, { bold: true });
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
