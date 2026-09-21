import { Worker } from 'node:worker_threads';
import { sendJson } from './http.js';

// FIX: the CPU-heavy part runs in a worker thread, so the main event loop
// keeps serving other requests. For sustained load, use a worker pool
// (e.g. piscina) instead of one worker per request.
function buildReportInWorker(cpuMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./report-worker.js', import.meta.url), {
      workerData: { cpuMs },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

export async function heavyReport(req, res) {
  const report = await buildReportInWorker(120);
  sendJson(res, 200, report);
}
