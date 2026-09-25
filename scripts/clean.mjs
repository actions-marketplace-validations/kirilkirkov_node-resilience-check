// Removes the tsc build output but keeps dist/action/, the committed
// GitHub Action bundle (rebuilt separately by `pnpm build:action`).
import { readdirSync, rmSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
let entries = [];
try {
  entries = readdirSync(dist);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const entry of entries) {
  if (entry !== 'action') rmSync(new URL(entry, dist), { recursive: true, force: true });
}
