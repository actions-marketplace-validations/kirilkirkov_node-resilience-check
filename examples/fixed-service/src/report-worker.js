import { parentPort, workerData } from 'node:worker_threads';

// Same CPU-bound work as the broken example, now off the main thread.
const started = performance.now();
let checksum = 0;
let rows = 0;
while (performance.now() - started < workerData.cpuMs) {
  for (let i = 0; i < 10_000; i++) checksum = (checksum * 31 + i) % 1_000_003;
  rows++;
}
parentPort.postMessage({ rows, checksum });
