import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPayPal } from './paypal.mjs';
import { parseInvoice, decide, thanksMessage, nudgeMessage, appendTrail, verifyTrail } from './agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ui = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const paypal = createPayPal();
const state = { trail: [], invoices: [], lastInvoice: null };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}

const routes = {
  'GET /': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ui);
  },
  'GET /api/health': (req, res) => json(res, 200, { ok: true, mode: paypal.mode, trail: verifyTrail(state.trail) }),
  'GET /api/trail': (req, res) => json(res, 200, { trail: state.trail, verify: verifyTrail(state.trail) }),

  'POST /api/extract': async (req, res) => {
    const { text } = await readBody(req);
    if (!text || typeof text !== 'string') return json(res, 400, { error: 'text required' });
    const invoice = parseInvoice(text);
    const decision = decide(invoice, state.invoices);
    state.trail = appendTrail(state.trail, { step: 'extract', invoiceNumber: invoice.invoiceNumber, totalCents: invoice.totalCents, verdict: decision.verdict, score: decision.score });
    state.lastInvoice = invoice;
    return json(res, 200, { invoice, decision, nudge: nudgeMessage(invoice, 5), thanks: thanksMessage(invoice) });
  },

  'POST /api/invoice': async (req, res) => {
    const invoice = state.lastInvoice;
    if (!invoice) return json(res, 400, { error: 'extract first' });
    const decision = decide(invoice, state.invoices);
    if (decision.verdict === 'BLOCK') {
      state.trail = appendTrail(state.trail, { step: 'invoice.blocked', invoiceNumber: invoice.invoiceNumber, reasons: decision.reasons });
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
    state.trail = appendTrail(state.trail, { step: 'invoice.sent', invoiceNumber: invoice.invoiceNumber, paypalId: created.id, totalCents: invoice.totalCents });
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
    state.trail = appendTrail(state.trail, { step: 'order.created', invoiceNumber: invoice.invoiceNumber, orderId: order.id, amountCents: invoice.totalCents });
    return json(res, 200, { order, mode: paypal.mode });
  },

  'POST /api/capture': async (req, res) => {
    const { orderId } = await readBody(req);
    if (!orderId) return json(res, 400, { error: 'orderId required' });
    const cap = await paypal.captureOrder(orderId);
    state.trail = appendTrail(state.trail, { step: 'order.captured', orderId, status: cap.status, captureId: cap.capture_id || null });
    return json(res, 200, { capture: cap, thanks: state.lastInvoice ? thanksMessage(state.lastInvoice) : null, mode: paypal.mode });
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
  console.log('invoice-cash-agent on http://127.0.0.1:' + port + ' | paypal mode: ' + paypal.mode);
});
