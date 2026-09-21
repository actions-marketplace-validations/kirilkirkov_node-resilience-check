// Test fixture: a service that crashes when /crash is requested.
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.url === '/crash') {
    console.error('fatal: simulated crash while handling /crash');
    process.exit(1);
  }
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');
