import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, decide, moneyToCents, appendTrail, verifyTrail, nudgeMessage } from '../src/agent.mjs';

const SAMPLE = [
  'Invoice #ACME-1042',
  'Client: billing@acme.example',
  'Net 30',
  '',
  'Design sprint - 1,200.00 USD',
  '2 x Landing page copy - 450.00 USD',
  'Hosting reimbursement - 60.00 USD',
  'Total 2,160.00 USD',
].join('\n');

test('money parses with commas', () => {
  assert.equal(moneyToCents('1,200.00'), 120000);
  assert.equal(moneyToCents('60.00'), 6000);
});

test('invoice number, email and net days are read', () => {
  const inv = parseInvoice(SAMPLE);
  assert.equal(inv.invoiceNumber, 'ACME-1042');
  assert.equal(inv.clientEmail, 'billing@acme.example');
  assert.equal(inv.dueDays, 30);
});

test('line items are read and multiplied by quantity', () => {
  const inv = parseInvoice(SAMPLE);
  assert.equal(inv.items.length, 3);
  assert.equal(inv.items[1].quantity, 2);
  assert.equal(inv.totalCents, 120000 + 90000 + 6000);
});

test('declared total is compared with the computed one', () => {
  const inv = parseInvoice(SAMPLE);
  assert.equal(inv.declaredCents, 216000);
  assert.equal(inv.totalMatchesDeclared, true);
});

test('mismatch between items and declared total is flagged', () => {
  const bad = SAMPLE.replace('Total 2,160.00 USD', 'Total 2,600.00 USD');
  const inv = parseInvoice(bad);
  assert.equal(inv.totalMatchesDeclared, false);
  const d = decide(inv, []);
  assert.equal(d.verdict, 'BLOCK');
  assert.ok(d.reasons.some(r => r.includes('add up to')));
});

test('missing client email blocks the invoice', () => {
  const inv = parseInvoice('Invoice #X-1\nDesign - 500.00 USD\nTotal 500.00 USD');
  const d = decide(inv, []);
  assert.equal(d.verdict, 'BLOCK');
});

test('clean invoice with known client is sendable', () => {
  const inv = parseInvoice(SAMPLE);
  const d = decide(inv, [{ clientEmail: 'billing@acme.example' }]);
  assert.equal(d.verdict, 'SEND');
  assert.equal(d.score, 0);
});

test('large amount forces review, not a block', () => {
  const big = SAMPLE.replace('1,200.00', '3,000.00').replace('Total 2,160.00', 'Total 3,960.00');
  const inv = parseInvoice(big);
  const d = decide(inv, [{ clientEmail: 'billing@acme.example' }]);
  assert.equal(d.verdict, 'REVIEW');
});

test('trail detects an edited record', () => {
  let trail = appendTrail([], { step: 'a', v: 1 });
  trail = appendTrail(trail, { step: 'b', v: 2 });
  assert.equal(verifyTrail(trail).ok, true);
  trail[0] = { ...trail[0], v: 99 };
  assert.equal(verifyTrail(trail).ok, false);
});

// Regression: real invoices usually print bare amounts and put the currency in the
// header. Before this test the parser read zero line items from such a document and
// the agent blocked a perfectly good invoice.
test('bare amounts without a currency marker are still read', () => {
  const plain = [
    'Acme Studio - invoice #ACME-1042',
    'bill to billing@acme.example',
    'Design sprint - 1200.00',
    '2 x Landing page copy - 450.00',
    'Net 30',
    'Total 2100.00',
  ].join('\n');
  const inv = parseInvoice(plain);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[1].quantity, 2);
  assert.equal(inv.totalCents, 210000);
  assert.equal(inv.totalMatchesDeclared, true);
  assert.equal(decide(inv, []).verdict, 'SEND');
});

test('a bare integer such as net 30 is not mistaken for an amount', () => {
  const inv = parseInvoice('Invoice #N-9\nbilling@acme.example\nNet 30\nRetainer - 900.00\nTotal 900.00');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.dueDays, 30);
  assert.equal(inv.totalCents, 90000);
});

test('nudge tone escalates with days late', () => {
  const inv = parseInvoice(SAMPLE);
  assert.ok(nudgeMessage(inv, 2).startsWith('a gentle note'));
  assert.ok(nudgeMessage(inv, 8).startsWith('a direct reminder'));
  assert.ok(nudgeMessage(inv, 21).startsWith('a final notice'));
});
