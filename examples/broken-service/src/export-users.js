const USER_COUNT = 20_000;

function csvRow(id) {
  const notes = 'lorem ipsum dolor sit amet '.repeat(12);
  return `${id},User ${id},user${id}@example.com,BG,2024-01-01T00:00:00Z,"${notes}"\n`;
}

export function exportUsers(req, res) {
  res.writeHead(200, { 'content-type': 'text/csv' });
  res.write('id,name,email,country,created_at,notes\n');
  for (let id = 1; id <= USER_COUNT; id++) {
    // BUG: the return value of write() is ignored. With a slow client every
    // remaining row is buffered in memory instead of pausing until 'drain'.
    // With enough concurrent exports this is how services run out of memory.
    res.write(csvRow(id));
  }
  res.end();
}
