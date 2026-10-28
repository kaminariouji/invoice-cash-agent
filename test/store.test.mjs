import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ica-'));

test('a trail survives a restart and keeps chaining', () => {
  const dir = tmp();
  const a = createStore(dir);
  a.append({ step: 'extract', v: 1 });
  a.append({ step: 'invoice.sent', v: 2 });

  const b = createStore(dir);
  assert.equal(b.all().length, 2);
  assert.equal(b.verify().ok, true);

  b.append({ step: 'order.captured', v: 3 });
  const c = createStore(dir);
  assert.equal(c.all().length, 3);
  assert.equal(c.verify().ok, true);
});

test('an edited record on disk fails verification', () => {
  const dir = tmp();
  const a = createStore(dir);
  a.append({ step: 'extract', v: 1 });
  a.append({ step: 'invoice.sent', v: 2 });

  const file = path.join(dir, 'trail.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.v = 99;
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  assert.equal(createStore(dir).verify().ok, false);
});

test('a torn last line is dropped, the rest of the chain stands', () => {
  const dir = tmp();
  const a = createStore(dir);
  a.append({ step: 'extract', v: 1 });

  const file = path.join(dir, 'trail.jsonl');
  fs.appendFileSync(file, '{"step":"order.cr');

  const b = createStore(dir);
  assert.equal(b.all().length, 1);
  assert.equal(b.verify().ok, true);
  b.append({ step: 'invoice.sent', v: 2 });
  assert.equal(createStore(dir).verify().ok, true);
});
