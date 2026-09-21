import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_COUNT = 20_000;

function csvRow(id) {
  const notes = 'lorem ipsum dolor sit amet '.repeat(12);
  return `${id},User ${id},user${id}@example.com,BG,2024-01-01T00:00:00Z,"${notes}"\n`;
}

function* rows() {
  yield 'id,name,email,country,created_at,notes\n';
  for (let id = 1; id <= USER_COUNT; id++) yield csvRow(id);
}

export async function exportUsers(req, res) {
  res.writeHead(200, { 'content-type': 'text/csv' });
  // FIX: pipeline() pulls the next row only when the response can take it
  // (it waits for 'drain'), and tears everything down if the client leaves.
  // The manual equivalent is: if (!res.write(row)) await once(res, 'drain').
  await pipeline(Readable.from(rows()), res);
}
