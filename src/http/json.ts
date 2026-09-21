import { request as httpRequest } from 'node:http';

export interface JsonRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

/** Minimal JSON-over-HTTP call used for the localhost CLI ⇄ agent channel. */
export function requestJson<T>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  return new Promise<T>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        agent: false,
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`${url} responded with ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`${url} returned invalid JSON`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${url} did not respond in time`)));
    req.on('error', reject);
    req.end(body);
  });
}
