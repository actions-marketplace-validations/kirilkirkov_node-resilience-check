import { sendJson } from './http.js';

/**
 * Stands in for CPU-heavy work done on the main thread: a large
 * JSON.stringify, synchronous crypto, a regex with catastrophic backtracking,
 * sorting a big array… It burns a fixed amount of CPU time so the demo
 * behaves the same on fast and slow machines.
 */
function buildReportSync(cpuMs) {
  const started = performance.now();
  let checksum = 0;
  let rows = 0;
  while (performance.now() - started < cpuMs) {
    for (let i = 0; i < 10_000; i++) checksum = (checksum * 31 + i) % 1_000_003;
    rows++;
  }
  return { rows, checksum };
}

export function heavyReport(req, res) {
  // BUG: ~120ms of synchronous work per request. While it runs, the event
  // loop cannot serve anything else: health checks, other users, timers.
  const report = buildReportSync(120);
  sendJson(res, 200, report);
}
