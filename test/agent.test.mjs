import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoice, decide, moneyToCents, appendTrail, verifyTrail, nudgeMessage, invoiceFromItems } from '../src/agent.mjs';

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

test('the item name does not keep the currency marker or the dash', () => {
  const inv = parseInvoice(SAMPLE);
  assert.deepEqual(inv.items.map(i => i.name), ['Design sprint', 'Landing page copy', 'Hosting reimbursement']);
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

// The grid is where a human fixes what a reader got wrong. These tests pin the rule that
// a correction is verified exactly like a first read - no special case, no bypass.
test('a human correction is verified like any other read', () => {
  const wrong = invoiceFromItems({
    invoiceNumber: 'ACME-1042',
    clientEmail: 'billing@acme.example',
    items: [{ name: 'Design sprint', quantity: 1, unit: 1200 }, { name: 'Landing page copy', quantity: 1, unit: 450 }],
    declaredCents: 210000,
  });
  assert.equal(wrong.totalCents, 165000);
  assert.equal(decide(wrong, []).verdict, 'BLOCK');

  const fixed = invoiceFromItems({
    invoiceNumber: 'ACME-1042',
    clientEmail: 'billing@acme.example',
    items: [{ name: 'Design sprint', quantity: 1, unit: 1200 }, { name: 'Landing page copy', quantity: 2, unit: 450 }],
    declaredCents: 210000,
  });
  assert.equal(fixed.totalCents, 210000);
  assert.equal(decide(fixed, []).verdict, 'SEND');
  assert.equal(fixed.engine, 'grid');
});

test('a row without a name or with a negative unit is dropped, not billed', () => {
  const inv = invoiceFromItems({ items: [{ name: '', unit: 10 }, { name: 'ok', unit: -5 }, { name: 'real', quantity: 3, unit: 100 }] });
  assert.equal(inv.items.length, 1);
  assert.equal(inv.totalCents, 30000);
});

test('an unknown printed total is reported as unknown, not as a match', () => {
  const inv = invoiceFromItems({ items: [{ name: 'x', quantity: 1, unit: 10 }] });
  assert.equal(inv.declaredCents, null);
  assert.equal(inv.totalMatchesDeclared, null);
});

test('nudge tone escalates with days late', () => {
  const inv = parseInvoice(SAMPLE);
  assert.ok(nudgeMessage(inv, 2).startsWith('a gentle note'));
  assert.ok(nudgeMessage(inv, 8).startsWith('a direct reminder'));
  assert.ok(nudgeMessage(inv, 21).startsWith('a final notice'));
});
