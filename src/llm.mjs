// The AI half. A model reads the messy document - the pasted email, the OCR text, the
// PDF dump - and returns structured line items. It is never trusted with the arithmetic:
// the total is recomputed here from its own items, and compared with the total it says
// the document printed. A model that invents a number produces a mismatch, and a
// mismatch is a finding, not a rounding note.

const SYSTEM = [
  'You read an invoice and return JSON only.',
  'Shape: {"invoiceNumber":string|null,"clientEmail":string|null,"dueDays":number,',
  '"currency":string,"items":[{"name":string,"quantity":number,"unit":number}],',
  '"declaredTotal":number|null}',
  'unit and declaredTotal are decimal numbers in the invoice currency, not strings.',
  'Copy the numbers exactly as printed. If a value is absent use null. Never compute a total.',
].join(' ');

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Turn whatever the model returned into the same shape parseInvoice() produces, so the
// policy layer cannot tell which one read the document.
export function normalise(raw) {
  const items = [];
  for (const it of Array.isArray(raw && raw.items) ? raw.items : []) {
    const unit = toNumber(it && it.unit);
    const quantity = toNumber(it && it.quantity);
    const name = it && typeof it.name === 'string' ? it.name.trim() : '';
    if (!name || unit === null || unit < 0) continue;
    items.push({ name: name.slice(0, 80), quantity: quantity && quantity > 0 ? quantity : 1, unit });
  }

  const totalCents = items.reduce((s, i) => s + Math.round(i.quantity * i.unit * 100), 0);
  const declared = toNumber(raw && raw.declaredTotal);
  const declaredCents = declared === null ? null : Math.round(declared * 100);
  const dueDays = toNumber(raw && raw.dueDays);

  return {
    currency: (raw && typeof raw.currency === 'string' && raw.currency.trim().toUpperCase()) || 'USD',
    clientEmail: raw && typeof raw.clientEmail === 'string' && raw.clientEmail.includes('@') ? raw.clientEmail.trim().toLowerCase() : null,
    invoiceNumber: raw && typeof raw.invoiceNumber === 'string' && raw.invoiceNumber.trim() ? raw.invoiceNumber.trim().toUpperCase() : null,
    dueDays: dueDays === null ? 14 : Math.min(120, Math.max(0, Math.round(dueDays))),
    items,
    totalCents,
    declaredCents,
    totalMatchesDeclared: declaredCents === null ? null : declaredCents === totalCents,
    engine: 'llm',
  };
}

export function llmConfigured(env = process.env) {
  return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL);
}

export async function extractWithLLM(text, env = process.env, fetchImpl = fetch) {
  if (!llmConfigured(env)) throw new Error('LLM is not configured: set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL');
  const base = env.LLM_BASE_URL.replace(/\/+$/, '');
  const r = await fetchImpl(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.LLM_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: String(text).slice(0, 12000) },
      ],
    }),
  });
  if (!r.ok) throw new Error('llm ' + r.status);
  const j = await r.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('llm returned no content');
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error('llm did not return JSON'); }
  return normalise(parsed);
}
