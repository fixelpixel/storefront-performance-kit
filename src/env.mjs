// Load .env before anything reads process.env.
//
// Imported for its side effect at the top of the CLI, so every command sees the
// keys without each module having to know where they live. Real environment
// variables win, so CI and one-off overrides still work:
//   PAGESPEED_API_KEY=other node src/cli.mjs psi https://…
//
// .env is gitignored. Nothing here writes or logs a value.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // blanks and # comments
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue; // the real environment wins
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
