// Tiny helpers so the example has no dependencies.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Maps "METHOD /path" to a handler; `:id` segments are passed as params. */
export function createRouter(routes) {
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`);
    return { method, pattern, handler };
  });

  return async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    for (const route of compiled) {
      const match = route.pattern.exec(pathname);
      if (route.method === req.method && match) {
        try {
          await route.handler(req, res, ...match.slice(1));
        } catch (error) {
          console.error(error);
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
          else res.destroy();
        }
        return;
      }
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
