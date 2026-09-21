# Examples

Two small HTTP services with the same endpoints and no dependencies:

- [`broken-service`](broken-service) contains one intentional resilience bug per check.
- [`fixed-service`](fixed-service) is the same service with each bug fixed.

Run them from the repository root:

```bash
pnpm install
pnpm demo         # broken-service → 5 problems detected, exit code 1
pnpm demo:fixed   # fixed-service  → all checks pass, exit code 0
```

Both start a fake payments API inside the same process, so each demo is a single command.
The service still reaches it over HTTP through `PAYMENTS_URL`, which is what lets
ResilienceCheck put its fault proxy in between.

## The bugs and their fixes

| Check             | Endpoint                     | Bug (`broken-service`)                                                                                 | Fix (`fixed-service`)                                                                               |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Event loop        | `GET /heavy-report`          | ~120ms of synchronous CPU work on the main thread ([src](broken-service/src/heavy-report.js))          | Work moved to a worker thread ([src](fixed-service/src/heavy-report.js))                            |
| Backpressure      | `GET /export/users`          | Writes ~8 MB of CSV rows ignoring `write()`'s return value ([src](broken-service/src/export-users.js)) | `pipeline(Readable.from(rows()), res)` ([src](fixed-service/src/export-users.js))                   |
| Retry behavior    | `POST /checkout`             | 5 retries after a fixed 50ms, no jitter ([src](broken-service/src/checkout.js))                        | 3 attempts max, exponential backoff with full jitter ([src](fixed-service/src/checkout.js))         |
| Concurrency       | `POST /products/:id/reserve` | Reads stock, awaits, then writes: check-then-act race ([src](broken-service/src/inventory.js))         | Check and decrement in one step ([src](fixed-service/src/inventory.js))                             |
| Graceful shutdown | `GET /slow`                  | No `SIGTERM` handler ([server.js](broken-service/server.js))                                           | `server.close()`, wait for in-flight requests, hard deadline ([server.js](fixed-service/server.js)) |

Compare the two directories side by side:

```bash
diff -r examples/broken-service examples/fixed-service
```

## What each run shows

**Event loop.** Ten requests (five at a time) to `/heavy-report`. In the broken service
they queue behind each other on the main thread; p99 event-loop delay is several hundred
milliseconds. In the fixed service the main thread stays free and p99 is a few milliseconds.

**Backpressure.** A client requests `/export/users` and stops reading for 500ms. The broken
handler keeps calling `res.write()` for all 20,000 rows although the response has been
signalling "buffer full" since the first few rows. ResilienceCheck reports the number of
ignored writes and the line that made them (`src/export-users.js:15`). The fixed handler
pauses until `'drain'`.

**Retry behavior.** The payments dependency returns `503` for two seconds. Twenty checkout
requests turn into 120 payment attempts in the broken service (6 per request, arriving in
synchronized waves every ~50ms). The fixed service makes at most 3 attempts per request, with
randomized delays.

**Concurrency.** Ten simultaneous reservations for a product with one unit in stock. All ten
succeed in the broken service; exactly one succeeds in the fixed service. The
`POST /test/reset-stock` endpoint exists only so the scenario can be repeated (`setup`).

**Graceful shutdown.** Twenty requests to `/slow` (800ms each), then `SIGTERM`. The broken
service dies within milliseconds and all twenty are dropped. The fixed service stops
accepting connections, finishes the twenty requests and exits.
