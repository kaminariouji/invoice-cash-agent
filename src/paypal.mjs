// PayPal adapter. Two modes:
//   mock    - no credentials, reproduces the documented request/response shapes
//   sandbox - real calls to api-m.sandbox.paypal.com
// The rest of the app never knows which one it is talking to.

const MODES = new Set(['mock', 'sandbox']);

export function createPayPal(env = process.env) {
  const mode = MODES.has(env.PAYPAL_MODE) ? env.PAYPAL_MODE : 'mock';
  const clientId = env.PAYPAL_CLIENT_ID || '';
  const secret = env.PAYPAL_CLIENT_SECRET || '';
  if (mode === 'sandbox' && (!clientId || !secret)) {
    throw new Error('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  }
  const base = mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.sandbox.paypal.com';
  let token = null;
  let tokenAt = 0;

  async function accessToken() {
    if (mode === 'mock') return 'mock-token';
    if (token && Date.now() - tokenAt < 3000 * 1000) return token;
    const basic = Buffer.from(clientId + ':' + secret).toString('base64');
    const r = await fetch(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: { authorization: 'Basic ' + basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) throw new Error('paypal auth failed: ' + r.status);
    const j = await r.json();
    token = j.access_token;
    tokenAt = Date.now();
    return token;
  }

  async function call(path, init = {}) {
    const t = await accessToken();
    const r = await fetch(base + path, {
      ...init,
      headers: {
        authorization: 'Bearer ' + t,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!r.ok) {
      const err = new Error('paypal ' + path + ' -> ' + r.status);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // Invoicing v2: create a draft invoice, then send it.
  async function createInvoice({ invoiceNumber, recipientEmail, items, currency = 'USD', note }) {
    if (mode === 'mock') {
      return {
        id: 'INV2-MOCK-' + invoiceNumber,
        status: 'DRAFT',
        detail: { invoice_number: invoiceNumber, currency_code: currency, note },
        invoicer: { email_address: 'merchant@example.com' },
        primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
        items: items.map(i => ({ name: i.name, quantity: String(i.quantity), unit_amount: { currency_code: currency, value: i.unit.toFixed(2) } })),
        amount: { currency_code: currency, value: items.reduce((s, i) => s + i.quantity * i.unit, 0).toFixed(2) },
        mock: true,
      };
    }
    return call('/v2/invoicing/invoices', {
      method: 'POST',
      body: JSON.stringify({
        detail: { invoice_number: invoiceNumber, currency_code: currency, note },
        primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
        items: items.map(i => ({
          name: i.name,
          quantity: String(i.quantity),
          unit_amount: { currency_code: currency, value: i.unit.toFixed(2) },
        })),
      }),
    });
  }

  async function sendInvoice(invoiceId) {
    if (mode === 'mock') return { status: 'SENT', invoice_id: invoiceId, mock: true };
    return call('/v2/invoicing/invoices/' + invoiceId + '/send', {
      method: 'POST',
      body: JSON.stringify({ send_to_recipient: true, send_to_invoicer: false }),
    });
  }

  async function getInvoice(invoiceId) {
    if (mode === 'mock') return { id: invoiceId, status: 'SENT', mock: true };
    return call('/v2/invoicing/invoices/' + invoiceId);
  }

  // Orders v2: the one-tap payment link the client actually uses.
  async function createOrder({ amount, currency = 'USD', description, reference }) {
    if (mode === 'mock') {
      return {
        id: 'ORDER-MOCK-' + reference,
        status: 'CREATED',
        links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-MOCK-' + reference }],
        purchase_units: [{ amount: { currency_code: currency, value: amount.toFixed(2) }, description }],
        mock: true,
      };
    }
    return call('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: currency, value: amount.toFixed(2) }, description, reference_id: reference }],
      }),
    });
  }

  async function captureOrder(orderId) {
    if (mode === 'mock') {
      return { id: orderId, status: 'COMPLETED', mock: true, capture_id: 'CAP-MOCK-' + orderId };
    }
    return call('/v2/checkout/orders/' + orderId + '/capture', { method: 'POST', body: '{}' });
  }

  // Webhook signature check. PayPal signs every notification; without this an attacker
  // could POST "payment received" and the agent would close an invoice nobody paid.
  async function verifyWebhook(headers, rawBody) {
    if (mode === 'mock') return { ok: true, mode: 'mock', verification_status: 'MOCK' };
    const webhookId = env.PAYPAL_WEBHOOK_ID || '';
    if (!webhookId) return { ok: false, reason: 'PAYPAL_WEBHOOK_ID is not set' };
    const h = (k) => headers[k] || headers[k.toLowerCase()] || '';
    let event;
    try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: 'bad json' }; }
    try {
      const r = await call('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: JSON.stringify({
          auth_algo: h('paypal-auth-algo'),
          cert_url: h('paypal-cert-url'),
          transmission_id: h('paypal-transmission-id'),
          transmission_sig: h('paypal-transmission-sig'),
          transmission_time: h('paypal-transmission-time'),
          webhook_id: webhookId,
          webhook_event: event,
        }),
      });
      return { ok: r && r.verification_status === 'SUCCESS', mode: 'sandbox', verification_status: r && r.verification_status };
    } catch (e) {
      return { ok: false, reason: String(e.message || e), status: e.status || null };
    }
  }

  return { mode, verifyWebhook, createInvoice, sendInvoice, getInvoice, createOrder, captureOrder };
}
