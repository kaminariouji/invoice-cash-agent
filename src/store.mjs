// Durable trail. The chain lives on disk as one JSON object per line, so a restart
// continues the same chain instead of starting a fresh one. A torn last line (a
// crash mid-write) is dropped rather than allowed to poison the whole file.

import fs from 'node:fs';
import path from 'node:path';
import { appendTrail, verifyTrail } from './agent.mjs';

export function createStore(dir) {
  const file = path.join(dir, 'trail.jsonl');
  fs.mkdirSync(dir, { recursive: true });

  let trail = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { trail.push(JSON.parse(line)); } catch { break; }
    }
  }

  function append(record) {
    trail = appendTrail(trail, record);
    const last = trail[trail.length - 1];
    fs.appendFileSync(file, JSON.stringify(last) + '\n');
    return last;
  }

  return {
    file,
    all: () => trail,
    append,
    verify: () => verifyTrail(trail),
  };
}
