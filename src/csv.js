/**
 * csv.js -- tiny RFC 4180 CSV reader/writer for the batch sender
 * --------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-09-28
 *
 * Deploy:  Imported by scripts/send-batch.js.
 *
 * What it does:
 *   Parses a CSV with a header row into objects (quoted fields, embedded
 *   commas, quotes and newlines supported) and escapes values for writing.
 *
 * Why it exists:
 *   Messages contain commas and line breaks. A naive split(',') would cut a
 *   message in half and send the fragment to a member. No dependency needed.
 */

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/^﻿/, ''); // strip a UTF-8 BOM from Excel exports
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header = [], ...body] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values) => values.map(csvEscape).join(',') + '\n';
