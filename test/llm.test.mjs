import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, extractWithLLM, llmConfigured } from '../src/llm.mjs';
import { decide } from '../src/agent.mjs';

const ENV = { LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' };

test('a model reply becomes the same invoice shape the parser produces', () => {
  const inv = normalise({
    invoiceNumber: 'acme-1042',
    clientEmail: 'Billing@Acme.example',
    dueDays: '30',
    currency: 'usd',
    items: [{ name: 'Design sprint', quantity: 1, unit: 1200 }, { name: 'Landing page copy', quantity: 2, unit: '450.00' }],
    declaredTotal: '2100.00',
  });
  assert.equal(inv.invoiceNumber, 'ACME-1042');
  assert.equal(inv.clientEmail, 'billing@acme.example');
  assert.equal(inv.currency, 'USD');
  assert.equal(inv.totalCents, 210000);
  assert.equal(inv.totalMatchesDeclared, true);
  assert.equal(decide(inv, []).verdict, 'SEND');
});

test('a total the model invents is caught by recomputing from its own items', () => {
  const inv = normalise({
    clientEmail: 'billing@acme.example',
    items: [{ name: 'Design sprint', quantity: 1, unit: 1200 }],
    declaredTotal: 2100,
  });
  assert.equal(inv.totalCents, 120000);
  assert.equal(inv.totalMatchesDeclared, false);
  const d = decide(inv, []);
  assert.equal(d.verdict, 'BLOCK');
  assert.ok(d.reasons.some((r) => r.includes('add up to')));
});

test('junk items are dropped rather than guessed at', () => {
  const inv = normalise({ items: [{ name: '', unit: 10 }, { name: 'ok', unit: 'free' }, { name: 'real', quantity: 0, unit: 5 }] });
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].quantity, 1);
  assert.equal(inv.totalCents, 500);
});

test('an unconfigured model is refused instead of silently falling back', () => {
  assert.equal(llmConfigured({}), false);
  assert.equal(llmConfigured(ENV), true);
});

test('the request is a plain chat completion with a JSON reply', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: [{ name: 'X', quantity: 1, unit: 10 }], declaredTotal: 10 }) } }] }),
    };
  };
  const inv = await extractWithLLM('some invoice text', ENV, fake);
  assert.equal(seen.url, 'https://llm.example/v1/chat/completions');
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.response_format.type, 'json_object');
  assert.equal(inv.totalCents, 1000);
  assert.equal(inv.engine, 'llm');
});
