// The agent: read a pasted invoice, decide whether it is safe to bill, write the
// client-facing words, and keep a hash-chained trail of every decision.
// Deterministic core first; an LLM only rewrites the prose, never the numbers.

import crypto from 'node:crypto';

// An amount is either prefixed/suffixed with a currency marker, or a bare number
// carrying exactly two decimals. Requiring the two decimals is what keeps "Net 30"
// and dates like 2026-10-28 out of the line items.
const MONEY = /(?:USD|US\$|\$)\s?([0-9][0-9,]*(?:\.[0-9]{2})?)|([0-9][0-9,]*\.[0-9]{2})/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function moneyToCents(s) {
  const m = String(s).replace(/,/g, '');
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(m)) throw new Error('not money: ' + s);
  const [whole, frac = ''] = m.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function parseInvoice(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  let currency = 'USD';
  let clientEmail = null;
  let invoiceNumber = null;
  let dueDays = 14;

  const emailMatch = String(text).match(EMAIL);
  if (emailMatch) clientEmail = emailMatch[0].toLowerCase();

  const invMatch = String(text).match(/(?:invoice|inv)\s*#?\s*([A-Z0-9][A-Z0-9-]{2,})/i);
  if (invMatch) invoiceNumber = invMatch[1].toUpperCase();

  const dueMatch = String(text).match(/net\s*(\d{1,3})/i);
  if (dueMatch) dueDays = Math.min(120, Math.max(0, Number(dueMatch[1])));

  for (const line of lines) {
    const m = line.match(MONEY);
    if (!m) continue;
    const amount = m[1] || m[2];
    if (!amount) continue;
    const label = line.replace(m[0], '').replace(/^[-*\u2022\s]+/, '').replace(/[\u2013\u2014-]\s*$/, '').trim();
    if (!label) continue;
    if (/total|subtotal|tax|vat|balance|due/i.test(label)) continue;
    const qtyMatch = label.match(/^(\d{1,3})\s*[x\u00d7]\s*/i);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;
    const raw = qtyMatch ? label.slice(qtyMatch[0].length).trim() : label;
    // "Design sprint - 1,200.00 USD" leaves "- USD" behind once the amount is removed.
    const name = raw.replace(/\s*[-\u2013\u2014]?\s*(?:USD|US\$|\$)\s*$/i, '').replace(/[\s\-\u2013\u2014]+$/, '').trim();
    if (!name) continue;
    items.push({ name: name.slice(0, 80), quantity, unit: moneyToCents(amount) / 100 });
  }

  const totalCents = items.reduce((s, i) => s + Math.round(i.quantity * i.unit * 100), 0);
  const declared = String(text).match(/total[^0-9]{0,12}([0-9][0-9,]*\.[0-9]{2})/i);
  const declaredCents = declared ? moneyToCents(declared[1]) : null;

  return {
    currency,
    clientEmail,
    invoiceNumber: invoiceNumber || 'INV-' + new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    dueDays,
    items,
    totalCents,
    declaredCents,
    totalMatchesDeclared: declaredCents === null ? null : declaredCents === totalCents,
  };
}

// The human half of the loop. The grid is where a person corrects what a reader got
// wrong; every correction goes back through the same verifier, so a fixed total is
// still checked against the total the document printed.
export function invoiceFromItems(input) {
  const items = [];
  for (const it of Array.isArray(input && input.items) ? input.items : []) {
    const name = it && typeof it.name === 'string' ? it.name.trim() : '';
    const unit = Number(it && it.unit);
    const quantity = Number(it && it.quantity);
    if (!name || !Number.isFinite(unit) || unit < 0) continue;
    items.push({ name: name.slice(0, 80), quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1, unit });
  }

  const totalCents = items.reduce((s, i) => s + Math.round(i.quantity * i.unit * 100), 0);
  const declared = Number(input && input.declaredCents);
  const declaredCents = Number.isFinite(declared) ? Math.round(declared) : null;
  const dueDays = Number(input && input.dueDays);

  return {
    currency: (input && typeof input.currency === 'string' && input.currency.trim()) || 'USD',
    clientEmail: (input && typeof input.clientEmail === 'string' && input.clientEmail.includes('@')) ? input.clientEmail.trim().toLowerCase() : null,
    invoiceNumber: (input && typeof input.invoiceNumber === 'string' && input.invoiceNumber.trim()) || 'INV-UNKNOWN',
    dueDays: Number.isFinite(dueDays) ? Math.min(120, Math.max(0, Math.round(dueDays))) : 14,
    items,
    totalCents,
    declaredCents,
    totalMatchesDeclared: declaredCents === null ? null : declaredCents === totalCents,
    engine: 'grid',
  };
}

// Policy: deterministic, explainable, and never allowed to be talked out of a block.
export function decide(invoice, history = []) {
  const reasons = [];
  let score = 0;

  if (!invoice.clientEmail) { score += 40; reasons.push('no client email - the invoice cannot be delivered'); }
  if (!invoice.items.length) { score += 60; reasons.push('no line items could be read'); }
  if (invoice.totalCents <= 0) { score += 60; reasons.push('total is zero or negative'); }
  if (invoice.totalMatchesDeclared === false) {
    // A document whose own numbers do not add up is never sent, however it was read.
    score += 45;
    reasons.push('line items add up to ' + (invoice.totalCents / 100).toFixed(2) + ' but the document says ' + (invoice.declaredCents / 100).toFixed(2));
  }
  if (invoice.totalCents > 250000) { score += 25; reasons.push('amount is above the 2,500.00 review threshold'); }
  if (invoice.dueDays > 60) { score += 10; reasons.push('due date is more than 60 days out'); }

  const seen = new Set(history.map(h => h.clientEmail).filter(Boolean));
  if (invoice.clientEmail && !seen.has(invoice.clientEmail) && history.length > 0) {
    score += 10;
    reasons.push('first invoice to this client');
  }

  const verdict = score >= 40 ? 'BLOCK' : score >= 20 ? 'REVIEW' : 'SEND';
  return { verdict, score, reasons };
}

export function thanksMessage(invoice) {
  const total = (invoice.totalCents / 100).toFixed(2);
  return 'Thanks - invoice ' + invoice.invoiceNumber + ' for ' + total + ' USD is paid and closed on our side. ' +
    'Nothing else is needed from you. If your finance team needs a receipt with the PayPal capture id, reply and I will send it.';
}

export function nudgeMessage(invoice, daysLate) {
  const total = (invoice.totalCents / 100).toFixed(2);
  const tone = daysLate <= 3 ? 'a gentle note' : daysLate <= 10 ? 'a direct reminder' : 'a final notice';
  return tone + ': invoice ' + invoice.invoiceNumber + ' for ' + total + ' USD was due ' + daysLate +
    ' day(s) ago and is still open. The PayPal link in the original email still works. If it was paid from another account, reply with the date and I will match it.';
}

// Hash-chained decision trail: each record commits to the one before it.
export function appendTrail(trail, record) {
  const prev = trail.length ? trail[trail.length - 1].hash : 'genesis';
  const payload = { ...record, prev };
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return [...trail, { ...payload, hash }];
}

export function verifyTrail(trail) {
  let prev = 'genesis';
  for (const r of trail) {
    const { hash, ...rest } = r;
    if (rest.prev !== prev) return { ok: false, at: r };
    const expect = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (expect !== hash) return { ok: false, at: r };
    prev = hash;
  }
  return { ok: true, length: trail.length };
}
