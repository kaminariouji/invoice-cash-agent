import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPayPal } from './paypal.mjs';
import { createStore } from './store.mjs';
import { parseInvoice, decide, thanksMessage, nudgeMessage, invoiceFromItems } from './agent.mjs';
import { extractWithLLM, llmConfigured } from './llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ui = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const paypal = createPayPal();
const store = createStore(process.env.DATA_DIR || join(here, '..', 'data'));
const state = { invoices: [], lastInvoice: null };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}

const routes = {
  'GET /': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ui);
  },
  'GET /api/health': (req, res) => json(res, 200, { ok: true, mode: paypal.mode, llm: llmConfigured(), trail: store.verify() }),
  'GET /api/trail': (req, res) => json(res, 200, { trail: store.all(), verify: store.verify() }),

  'POST /api/extract': async (req, res) => {
    const { text, engine } = await readBody(req);
    if (!text || typeof text !== 'string') return json(res, 400, { error: 'text required' });
    let invoice;
    if (engine === 'llm') {
      if (!llmConfigured()) return json(res, 400, { error: 'model not configured', detail: 'set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL' });
      try {
        invoice = await extractWithLLM(text);
      } catch (e) {
        return json(res, 502, { error: 'model read failed', detail: String(e.message || e) });
      }
    } else {
      invoice = parseInvoice(text);
    }
    const decision = decide(invoice, state.invoices);
    store.append({ step: 'extract', engine: invoice.engine || 'parser', invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, verdict: decision.verdict, score: decision.score });
    state.lastInvoice = invoice;
    return json(res, 200, { invoice, decision, nudge: nudgeMessage(invoice, 5), thanks: thanksMessage(invoice) });
  },

  // Every cell edit in the grid comes back here: the same verifier runs on the corrected
  // numbers, so a human fix cannot smuggle in a total that does not add up.
  'POST /api/recompute': async (req, res) => {
    const body = await readBody(req);
    const invoice = invoiceFromItems(body);
    const decision = decide(invoice, state.invoices);
    state.lastInvoice = invoice;
    return json(res, 200, { invoice, decision });
  },

  'POST /api/invoice': async (req, res) => {
    const invoice = state.lastInvoice;
    if (!invoice) return json(res, 400, { error: 'extract first' });
    const decision = decide(invoice, state.invoices);
    if (decision.verdict === 'BLOCK') {
      store.append({ step: 'invoice.blocked', invoiceNumber: invoice.invoiceNumber, reasons: decision.reasons });
      return json(res, 409, { error: 'blocked by policy', decision });
    }
    const created = await paypal.createInvoice({
      invoiceNumber: invoice.invoiceNumber,
      recipientEmail: invoice.clientEmail,
      items: invoice.items,
      currency: invoice.currency,
      note: 'Thanks for your business. Payment due in ' + invoice.dueDays + ' days.',
    });
    const sent = await paypal.sendInvoice(created.id);
    state.invoices.push({ ...invoice, paypalId: created.id });
    store.append({ step: 'invoice.sent', invoiceNumber: invoice.invoiceNumber, paypalId: created.id, totalCents: invoice.totalCents });
    return json(res, 200, { created, sent, mode: paypal.mode });
  },

  'POST /api/order': async (req, res) => {
    const invoice = state.lastInvoice;
    if (!invoice) return json(res, 400, { error: 'extract first' });
    const order = await paypal.createOrder({
      amount: invoice.totalCents / 100,
      currency: invoice.currency,
      description: 'Invoice ' + invoice.invoiceNumber,
      reference: invoice.invoiceNumber,
    });
    store.append({ step: 'order.created', invoiceNumber: invoice.invoiceNumber, orderId: order.id, amountCents: invoice.totalCents });
    return json(res, 200, { order, mode: paypal.mode });
  },

  'POST /api/capture': async (req, res) => {
    const { orderId } = await readBody(req);
    if (!orderId) return json(res, 400, { error: 'orderId required' });
    const cap = await paypal.captureOrder(orderId);
    store.append({ step: 'order.captured', orderId, status: cap.status, captureId: cap.capture_id || null });
    return json(res, 200, { capture: cap, thanks: state.lastInvoice ? thanksMessage(state.lastInvoice) : null, mode: paypal.mode });
  },

  // PayPal calls this when money actually arrives, including payments the client made
  // through the emailed invoice link - which never touch /api/capture.
  'POST /api/webhook': async (req, res) => {
    const raw = await readRaw(req);
    const check = await paypal.verifyWebhook(req.headers, raw);
    if (!check.ok) {
      store.append({ step: 'webhook.rejected', reason: check.reason || 'signature' });
      return json(res, 400, { error: 'signature rejected', detail: check });
    }
    let event = {};
    try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
    const kind = event.event_type || 'unknown';
    const resource = event.resource || {};
    const paid = kind === 'PAYMENT.CAPTURE.COMPLETED' || kind === 'INVOICING.INVOICE.PAID';
    store.append({
      step: paid ? 'payment.received' : 'webhook.ignored',
      event: kind,
      id: resource.id || null,
      invoiceId: resource.invoice_id || null,
      amount: resource.amount ? resource.amount.value + ' ' + resource.amount.currency_code : null,
    });
    return json(res, 200, {
      ok: true,
      event: kind,
      thanks: paid && state.lastInvoice ? thanksMessage(state.lastInvoice) : null,
      trail: store.verify(),
    });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    await handler(req, res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e), detail: e.body || null });
  }
});

const port = Number(process.env.PORT || 8788);
server.listen(port, () => {
  console.log('invoice-cash-agent on http://127.0.0.1:' + port + ' | paypal mode: ' + paypal.mode + ' | trail ' + store.all().length);
});
