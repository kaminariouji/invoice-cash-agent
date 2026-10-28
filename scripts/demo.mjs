#!/usr/bin/env node
// End-to-end walkthrough: starts the real server, drives it over HTTP, restarts it to
// prove the trail is durable, and prints every step. No PayPal credentials needed -
// with PAYPAL_MODE unset the adapter answers with the documented sandbox shapes.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyTrail } from '../src/agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.DEMO_PORT || 8790);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = process.env.DEMO_DATA_DIR || join(tmpdir(), 'invoice-cash-agent-demo-' + process.pid);

const GOOD = [
  'Acme Studio - invoice #ACME-1042',
  'bill to billing@acme.example',
  'Design sprint - 1200.00',
  '2 x Landing page copy - 450.00',
  'Net 30',
  'Total 2100.00',
].join('\n');

const BAD = [
  'Invoice #OOPS-7',
  'Retainer - 900.00',
  'Total 1200.00',
].join('\n');

const say = (s) => console.log(s);
const rule = (t) => { say(''); say('== ' + t + ' ' + '='.repeat(Math.max(2, 62 - t.length))); };

async function post(path, body, headers) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function waitForHealth(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('server did not become healthy on ' + BASE);
}

function startServer() {
  const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, PAYPAL_MODE: process.env.PAYPAL_MODE || 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d.toString(); });
  child.stderr.on('data', (d) => { child.log += d.toString(); });
  return child;
}

const stop = (child) => new Promise((res) => {
  child.once('exit', () => res());
  try { child.kill(); } catch { res(); }
});

async function main() {
  say('starting server on port ' + PORT + ' with a fresh data dir ...');
  let child = startServer();
  try {
    const health = await waitForHealth();
    say('paypal adapter mode: ' + health.mode + ' | trail: ' + JSON.stringify(health.trail));

    rule('1. read the invoice');
    say(GOOD.split('\n').map((l) => '   | ' + l).join('\n'));
    const ex = await post('/api/extract', { text: GOOD });
    say('   invoice number : ' + ex.body.invoice.invoiceNumber);
    say('   client         : ' + ex.body.invoice.clientEmail);
    say('   due            : net ' + ex.body.invoice.dueDays + ' days');
    for (const it of ex.body.invoice.items) say('   line           : ' + it.quantity + ' x ' + it.name + ' @ ' + it.unit.toFixed(2));
    say('   computed total : ' + (ex.body.invoice.totalCents / 100).toFixed(2));
    say('   printed total  : ' + (ex.body.invoice.declaredCents === null ? 'n/a' : (ex.body.invoice.declaredCents / 100).toFixed(2)));
    say('   matches        : ' + ex.body.invoice.totalMatchesDeclared);
    say('   verdict        : ' + ex.body.decision.verdict + ' (score ' + ex.body.decision.score + ')');

    rule('2. a document that must not be billed');
    const bad = await post('/api/extract', { text: BAD });
    say('   verdict        : ' + bad.body.decision.verdict + ' (score ' + bad.body.decision.score + ')');
    for (const r of bad.body.decision.reasons) say('   reason         : ' + r);
    const blocked = await post('/api/invoice', {});
    say('   POST /api/invoice -> ' + blocked.status + ' ' + (blocked.body.error || ''));

    rule('3. extract the good invoice again and bill it');
    await post('/api/extract', { text: GOOD });
    const inv = await post('/api/invoice', {});
    say('   paypal invoice : ' + (inv.body.created && inv.body.created.id));
    say('   status         : ' + (inv.body.sent && inv.body.sent.status));
    say('   mode           : ' + inv.body.mode);

    rule('4. one-tap payment link');
    const ord = await post('/api/order', {});
    const link = (ord.body.order.links || []).find((l) => l.rel === 'approve');
    say('   order          : ' + ord.body.order.id);
    say('   approve link   : ' + (link ? link.href : 'n/a'));

    rule('5. capture the payment');
    const cap = await post('/api/capture', { orderId: ord.body.order.id });
    say('   status         : ' + cap.body.capture.status);
    say('   capture id     : ' + (cap.body.capture.capture_id || 'n/a'));

    rule('6. money that arrives through the emailed invoice instead');
    const hook = await post('/api/webhook', {
      id: 'WH-EVT-1',
      event_type: 'INVOICING.INVOICE.PAID',
      resource: { id: 'INV2-MOCK-ACME-1042', amount: { value: '2100.00', currency_code: 'USD' } },
    }, { 'paypal-transmission-id': 'demo-' + Date.now() });
    say('   webhook        : ' + hook.status + ' event ' + hook.body.event);
    say('   trail verify   : ' + JSON.stringify(hook.body.trail));

    rule('7. decision trail');
    const t = await fetch(BASE + '/api/trail').then((r) => r.json());
    for (const rec of t.trail) {
      say('   ' + rec.step.padEnd(16) + ' ' + rec.hash.slice(0, 16) + '  prev ' + String(rec.prev).slice(0, 12));
    }
    say('   chain verify   : ' + JSON.stringify(t.verify));

    rule('8. restart the process');
    const before = t.trail.length;
    await stop(child);
    child = startServer();
    const h2 = await waitForHealth();
    say('   trail before   : ' + before);
    say('   trail after    : ' + h2.trail.length + ' ' + JSON.stringify(h2.trail));

    rule('9. tamper with the trail');
    const copy = JSON.parse(JSON.stringify(t.trail));
    if (copy.length) {
      copy[copy.length - 1].step = 'order.refunded';
      say('   edited one record, verify -> ' + JSON.stringify(verifyTrail(copy)));
    }

    rule('done');
    say('   The numbers come from the document, not from a model.');
    say('   A block cannot be talked out of: policy runs before any PayPal call.');
    say('   Every step is committed to a hash chain on disk, so a restart keeps it and an edit breaks it.');
  } finally {
    await stop(child);
    if (child.log.trim()) {
      say('');
      say('server log: ' + child.log.trim().split('\n').slice(-2).join(' / '));
    }
  }
}

main().catch((e) => {
  console.error('demo failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
