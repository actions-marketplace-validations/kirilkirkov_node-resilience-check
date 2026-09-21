# ResilienceCheck

**Break your Node.js service before production does.**

```bash
npx node-resilience-check verify
```

```text
ResilienceCheck v0.1.0
Break your Node.js service before production does.

Service   http://127.0.0.1:3100
Command   node server.js
Seed      492813
Ready     pid 12443 · agent attached

✗ Event loop                  p99 483ms (limit 100ms)
    Event-loop delay while serving GET /heavy-report (10 requests, concurrency 5):
    p50 483ms · p95 483ms · p99 483ms · max 483ms (3 samples)
    Maximum observed delay: 483ms. The event loop was busy 100% of the time; synchronous work is blocking every other request.
✗ Backpressure                19,832 writes after write() returned false
    Writable stream (ServerResponse) ignored backpressure.
    write() returned false, then 19,832 more writes happened before 'drain'.
    Source: src/export-users.js:15
✗ Retry behavior              20 requests → 120 downstream attempts (6.00x)
    Retry amplification: 6.00x (limit 3.00x).
    Possible retry storm: a failing dependency receives several times the original traffic.
    Fault: HTTP 503 for 2.0s. 120 attempts received it, 0 were forwarded to http://127.0.0.1:4100.
    Heuristic: 100% of retries arrived in tight bursts (10+ attempts within 20ms). No meaningful jitter was observed.
    Heuristic: Retry waves arrived at steady ~53ms intervals; no exponential backoff was observed.
✗ Concurrency: reserve-stock  expected at most 1 successful, got 10
    Concurrent requests: 10 × POST /products/1/reserve
    Successful responses (status 200): 10
    Maximum allowed: 1
    Responses: 200×10
    Possible concurrency/race-condition bug: the invariant did not hold under simultaneous requests.
✗ Graceful shutdown           20 of 20 in-flight requests lost
    Requests in flight at SIGTERM: 20 (of 20 sent)
    Completed: 0
    Dropped (no complete response): 20
    Process exited 12ms after SIGTERM.
    No SIGTERM listener was registered, so Node.js used the default action and terminated immediately.
    A lost request did not receive a complete, non-5xx response. Clients may retry idempotent requests, but in-flight work was cut off.

────────────────────────────────────────────────────

5 resilience problems detected.
0 passed · 5 failed · 2.9s
Reproduce this run with --seed 492813
```

That is real output from the [example service](examples/broken-service) in this repository.

ResilienceCheck is an open-source CLI for **Node.js resilience testing**. It starts your
Node.js or TypeScript service locally, attaches a small runtime agent, deliberately provokes
failure conditions — a slow client, a failing dependency, simultaneous requests, a `SIGTERM`
in the middle of traffic — and reports concrete, Node-level problems: event loop blocking,
ignored stream backpressure, retry storms, broken graceful shutdown and violated concurrency
invariants. It exits non-zero when a check fails, so it fits straight into CI.

```text
Load testing asks:
"How much traffic can this service handle?"

Fault injection asks:
"What happens if this dependency fails?"

ResilienceCheck asks:
"When failure happens, does this Node.js service behave correctly?"
```

It is free and MIT-licensed. There is no paid version, account, dashboard, cloud backend or
telemetry — everything runs on your machine or CI runner and stays on `127.0.0.1`.

## Contents

- [Why](#why)
- [Quick start](#quick-start)
- [Supported checks](#supported-checks)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [The checks in detail](#the-checks-in-detail)
- [Try the demo](#try-the-demo)
- [CI usage](#ci-usage)
- [JSON report](#json-report)
- [Commands](#commands)
- [Limitations](#limitations)
- [How it compares](#how-it-compares)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security and safe use](#security-and-safe-use)
- [License](#license)

## Why

Most reliability bugs in Node.js microservices are not about raw throughput. They show up
when something around the service misbehaves:

- a handler does 200ms of synchronous work, and _every other request_ waits behind it;
- a CSV export ignores `write()` returning `false`, so one slow client makes the process
  buffer hundreds of megabytes;
- a dependency returns `503` for two seconds and each incoming request turns into six
  retries, fired in lockstep, keeping the dependency down;
- a deploy sends `SIGTERM` and the process exits immediately, cutting off in-flight requests;
- two simultaneous requests both reserve the last item in stock.

Unit tests rarely exercise these paths, load testers measure capacity rather than
correctness, and network fault-injection tools tell you _that_ a dependency failed, not how
your code reacted. ResilienceCheck runs targeted, repeatable scenarios for exactly these
failure modes and turns the observed behaviour into pass/fail results.

## Quick start

Requirements: Node.js 22.12 or newer. The service under test must be an HTTP service that
runs on Node.js (plain `node:http`, Express, Fastify, Koa, NestJS, … — anything built on
Node's HTTP server). TypeScript works the same way, whether you run compiled output or use a
loader such as `tsx`.

```bash
npm install --save-dev node-resilience-check

npx resilience-check init      # writes resiliencecheck.config.json
npx resilience-check doctor    # optional: checks Node version, command, port
npx resilience-check verify
```

Or without installing anything:

```bash
npx node-resilience-check verify
```

`init` guesses your start command from `package.json` and enables the two checks that work
for any HTTP service. Point each check at a real endpoint and enable the others as needed.

## Supported checks

| Check                 | What it provokes                            | What it reports                                                             |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| **Event loop**        | Load on an endpoint you choose              | Event-loop delay (mean, p50, p95, p99, max) and utilization                 |
| **Backpressure**      | A client that stops reading the response    | `write()` calls made after `write()` returned `false`, with source location |
| **Retry behavior**    | A dependency that returns `503` (or resets) | Retry amplification, plus heuristics on jitter and backoff                  |
| **Concurrency**       | Simultaneous identical requests             | Whether your invariant (e.g. "at most 1 success") held                      |
| **Graceful shutdown** | `SIGTERM` while requests are in flight      | Completed vs dropped requests, exit time, missing signal handler            |

All five are implemented in v0.1. Features listed under [Roadmap](#roadmap) are not.

## Configuration

`resiliencecheck.config.json`, slightly abridged from the demo's [configuration](examples/broken-service/resiliencecheck.config.json):

```json
{
  "service": {
    "command": "node server.js",
    "baseUrl": "http://127.0.0.1:3100",
    "healthPath": "/health",
    "startupTimeoutMs": 10000,
    "env": { "PORT": "3100" }
  },
  "checks": {
    "eventLoop": {
      "path": "/heavy-report",
      "requests": 10,
      "concurrency": 5,
      "maxP99Ms": 100
    },
    "backpressure": {
      "path": "/export/users",
      "holdMs": 500,
      "maxIgnoredWrites": 0
    },
    "retryStorm": {
      "dependency": { "env": "PAYMENTS_URL", "target": "http://127.0.0.1:4100" },
      "trigger": { "method": "POST", "path": "/checkout", "requests": 20, "concurrency": 20 },
      "fault": { "type": "status", "status": 503, "durationMs": 2000 },
      "maxAmplification": 3
    },
    "concurrency": [
      {
        "name": "reserve-stock",
        "request": { "method": "POST", "path": "/products/1/reserve", "body": { "quantity": 1 } },
        "requests": 10,
        "assert": { "status": 200, "maxSuccesses": 1 }
      }
    ],
    "gracefulShutdown": {
      "path": "/slow",
      "concurrency": 20,
      "signalAfterMs": 100,
      "shutdownTimeoutMs": 5000,
      "maxDroppedRequests": 0
    }
  }
}
```

A section that is missing, or has `"enabled": false`, is skipped. Every option and its
default is documented in **[docs/configuration.md](docs/configuration.md)** (JSON cannot hold
comments). Mistakes are reported as plain sentences:

```text
✗ Invalid configuration (./resiliencecheck.config.json):

    checks.eventLoop.maxP99Ms must be greater than 0.
    checks.eventLoop.maxP99 is not a known option. Did you mean "maxP99Ms"?
```

## How it works

```text
resilience-check CLI
├─ reporter server ....... 127.0.0.1:<random>   ◄── the agent registers here
├─ fault proxy ........... 127.0.0.1:<random>   ◄── the service's PAYMENTS_URL points here;
│                                                   forwards to the real dependency
│                                                   outside the fault window
├─ scenario runner ─────── HTTP load · slow reader · simultaneous requests · SIGTERM
│                                  │
│ spawn (own process group)        │
│ NODE_OPTIONS="… --import=<agent>"│
▼                                  ▼
your Node.js service
└─ preload agent
   ├─ event-loop histogram ..... monitorEventLoopDelay()
   ├─ write() instrumentation .. backpressure tracking
   ├─ in-flight counter ........ diagnostics_channel
   └─ control server ........... 127.0.0.1:<random>   ◄── the CLI starts/stops measurements
```

1. **Start.** The CLI starts your command in its own process group, with the agent added to
   `NODE_OPTIONS` via `--import` (your existing `NODE_OPTIONS` are preserved). When the retry
   check is enabled, the configured environment variable (e.g. `PAYMENTS_URL`) is replaced —
   only in the child's environment — with the address of a local fault proxy.
2. **Find the right process.** `NODE_OPTIONS` is inherited by every Node process the command
   starts (`npm`, shells, build tools). The agent stays inert until it sees the CLI's health
   check request, which carries a random token. Only the process that actually serves HTTP
   opens a localhost control channel and registers. This is how `npm start` works correctly:
   signals go to your Node.js process, not to npm.
3. **Run scenarios.** Each check runs a deterministic scenario and measures from both sides:
   the client side (responses, timings, dropped connections, attempts at the proxy) and the
   inside (event-loop histogram, stream state, in-flight request count, signal listeners).
4. **Report and clean up.** Results are printed as they arrive and optionally written as
   JSON. The service's whole process group, the proxy and the local servers are always shut
   down — on success, failure, startup errors and Ctrl+C.

The agent never changes application behaviour: it does not alter return values, swallow
errors or add routes to your app. Fault injection only happens in the proxy, and only
during the retry check.

## The checks in detail

### Event loop blocking

Node.js runs your JavaScript on one thread. Synchronous work — a big `JSON.stringify`, a
sort over a large array, `crypto.pbkdf2Sync`, a catastrophic regular expression — stops that
thread, and every other request, timer and health check waits.

While the check sends `requests` requests to `path` (with `concurrency` in flight), the agent
records event-loop delay with Node's native
[`monitorEventLoopDelay()`](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)
and event-loop utilization. Node reports nanoseconds; ResilienceCheck converts them to
milliseconds and fails when p99 exceeds `maxP99Ms`.

A fully blocked loop yields only a few histogram samples (the sampling timer cannot fire
while the loop is blocked), so the sample count and utilization are shown next to the
percentiles.

**Typical fixes:** move CPU-heavy work to `worker_threads` (or a pool such as piscina),
stream large payloads instead of building them in memory, split long loops with
`setImmediate`.

### Backpressure

When `writable.write()` returns `false`, the stream's buffer is full and the producer is
expected to stop and wait for `'drain'`. Code that keeps writing still "works" in tests, but
with a slow client every remaining chunk piles up in memory.

The check opens a raw socket, sends the request and then deliberately stops reading for
`holdMs`, so kernel buffers fill and the server's stream starts returning `false`. Inside
the service, the agent wraps `write()` on `Writable`, `Duplex` and `http.OutgoingMessage`
(HTTP responses are not `Writable` subclasses) and records every `write()` made while the
stream was still waiting for `'drain'`:

- return values, arguments and thrown errors are passed through untouched;
- state is kept in a `WeakMap`, and the drain state is read from `writableNeedDrain`, so no
  listeners are added to your streams;
- a stack trace is captured once per wait period and the first frame outside Node.js
  internals and `node_modules` is reported as the source;
- writes made by Node.js internals (for example HTTP flushing its own buffer) are ignored.

When no application frame is found, the wording changes to _"possible backpressure
violation inside a dependency"_. When `write()` never returned `false` during the scenario,
the check warns that backpressure was not exercised instead of passing silently.

**Typical fixes:** `await pipeline(Readable.from(rows()), res)`, or
`if (!res.write(chunk)) await once(res, 'drain')`.

### Retry storms

Retries are good until every instance retries at the same moment. A dependency that blips
for two seconds then receives several times its normal traffic in synchronized waves, which
keeps it down longer.

ResilienceCheck starts a small HTTP fault proxy on `127.0.0.1` and points the configured
environment variable at it. During the check it returns the configured fault (`503`, or a
connection reset) for `durationMs`, then forwards to the real target. It sends the trigger
requests and counts every attempt that reaches the proxy:

```text
retry amplification = downstream attempts / incoming trigger requests
```

The check fails above `maxAmplification`. It also reports two **heuristics** over the
attempt timestamps: whether retries arrived in tight synchronized bursts (no meaningful
jitter), and whether the gaps between retry waves grow (exponential backoff) or stay
constant. The proxy cannot tell which attempt belongs to which incoming request, so these
are observations, not proof, and they are labelled as such. Synchronized retries within the
amplification limit produce a warning.

This is not a general-purpose network fault proxy: HTTP only, one dependency, two fault
types. For latency, bandwidth or TCP-level faults, use a tool such as Toxiproxy.

**Typical fixes:** fewer attempts, exponential backoff with full jitter, retry budgets or a
circuit breaker, idempotency keys for retried writes.

### Graceful shutdown

Deploys, autoscaling and node drains all stop processes with `SIGTERM`. Without a handler,
Node.js terminates immediately and every in-flight request is cut off. With a handler that
never finishes (open keep-alive sockets, timers, database pools), the orchestrator eventually
sends `SIGKILL`.

The check starts `concurrency` requests to a (preferably slow) endpoint, waits until the
agent confirms they are in flight, waits `signalAfterMs`, and sends the signal **directly to
the Node.js process that serves HTTP**. It then measures:

- requests in flight when the signal was sent;
- **completed** (full response, status < 500), **failed** (5xx) and **dropped** (connection
  closed or reset without a complete response);
- how long the process took to exit, and whether it exceeded `shutdownTimeoutMs`
  (after which ResilienceCheck kills it);
- whether the application registered a listener for the signal at all.

A dropped request is not automatically a bug — clients may safely retry idempotent requests —
but it does mean in-flight work was cut off, and the report says exactly that. When no request
was in flight at the signal, the check warns that shutdown behaviour was not exercised.

Supported on Linux and macOS. On Windows the check is skipped, because POSIX signals do not
exist there.

**Typical fix:** on `SIGTERM`, call `server.close()`, wait for in-flight work, close pools,
and exit — with a hard deadline shorter than your orchestrator's grace period.

### Concurrency invariant testing

ResilienceCheck does **not** detect race conditions in arbitrary JavaScript — no tool can do
that reliably from the outside, and claiming otherwise would be misleading. Instead it
provides **concurrency invariant testing**: you describe a request and a property that must
hold when many copies of it arrive at once, and ResilienceCheck checks it.

```json
{
  "name": "reserve-stock",
  "setup": { "method": "POST", "path": "/test/reset-stock" },
  "request": { "method": "POST", "path": "/products/1/reserve", "body": { "quantity": 1 } },
  "requests": 10,
  "rounds": 3,
  "jitterMs": 0,
  "assert": { "status": 200, "maxSuccesses": 1 }
}
```

To make the requests truly simultaneous, every connection is opened first and all requests
are written in the same tick. Optional `jitterMs` delays each request by a random amount
drawn from a seeded generator; the seed is printed on every run and can be replayed with
`--seed`. An optional `setup` request (for example a test-only reset endpoint) runs before
each round.

A passing scenario means the invariant held for the interleavings that occurred in this
run — not that the code is race-free. Increase `rounds` and try different seeds to explore
more interleavings.

**Typical fixes:** make check-and-update a single atomic operation
(`UPDATE … SET stock = stock - 1 WHERE id = $1 AND stock >= 1`), use unique constraints,
optimistic locking or a per-key mutex.

## Try the demo

The repository contains two runnable services with identical endpoints:
[`examples/broken-service`](examples/broken-service) has one intentional bug per check, and
[`examples/fixed-service`](examples/fixed-service) shows how each one is fixed.

```bash
git clone https://github.com/kirilkirkov/node-resilience-check.git
cd node-resilience-check
pnpm install

pnpm demo         # broken-service: 5 problems detected, exit code 1
pnpm demo:fixed   # fixed-service: all checks pass, exit code 0
```

Nothing in the demo is simulated on the ResilienceCheck side: the checks run against real
processes, real sockets and real signals. See [examples/README.md](examples/README.md) for a
walkthrough of each bug and fix.

## CI usage

`verify` exits with:

| Code  | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| `0`   | All enabled checks passed (warnings allowed)                         |
| `1`   | At least one check failed, or could not produce a trustworthy result |
| `2`   | Configuration or startup problem — no checks were run                |
| `130` | Interrupted                                                          |

GitHub Actions example:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci
- run: npm run build
- run: npx resilience-check verify --json resiliencecheck-report.json
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: resiliencecheck-report
    path: resiliencecheck-report.json
```

Tips:

- Output is plain text automatically when stdout is not a TTY or `NO_COLOR` is set.
- The service's own logs are hidden by default; add `--verbose` to stream them to stderr.
- Use `--only event-loop,backpressure` to run a subset.
- Timing-based thresholds should leave headroom for slower CI machines.

## JSON report

`--json <path>` writes a machine-readable report with a stable, versioned shape
(`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "tool": { "name": "node-resilience-check", "version": "0.1.0" },
  "version": "0.1.0",
  "seed": 492813,
  "startedAt": "2026-09-21T07:18:21.049Z",
  "finishedAt": "2026-09-21T07:18:23.911Z",
  "durationMs": 2863,
  "environment": { "node": "v22.21.1", "platform": "darwin", "arch": "arm64" },
  "service": {
    "command": "node server.js",
    "baseUrl": "http://127.0.0.1:3100",
    "pid": 12302,
    "agent": true
  },
  "summary": { "total": 5, "passed": 0, "failed": 5, "warnings": 0, "skipped": 0, "errors": 0 },
  "exitCode": 1,
  "aborted": false,
  "fatalError": null,
  "checks": [
    {
      "id": "event-loop",
      "name": "Event loop",
      "status": "fail",
      "summary": "p99 483ms (limit 100ms)",
      "details": ["…"],
      "durationMs": 1204,
      "metrics": { "p50Ms": 482.87, "p95Ms": 482.87, "p99Ms": 482.87, "maxMs": 482.87, "…": "…" }
    }
  ]
}
```

Each check has a stable `id`, a `status` (`pass`, `fail`, `warn`, `skip`, `error`) and
check-specific `metrics`. Request and response bodies are never stored, and the fault proxy
records paths without query strings. The full schema
is in **[docs/json-report.md](docs/json-report.md)**.

```bash
# List failed checks
jq -r '.checks[] | select(.status == "fail") | "\(.name): \(.summary)"' resiliencecheck-report.json
```

## Commands

```text
resilience-check init [--config <path>] [--force]
resilience-check verify [--config <path>] [--seed <n>] [--json <path>] [--only <ids>] [--verbose] [--no-color]
resilience-check doctor [--config <path>]
resilience-check --version
resilience-check --help
```

- **`init`** — creates `resiliencecheck.config.json`, guessing the start command from
  `package.json`.
- **`verify`** — starts the service, runs the enabled checks, prints results, exits with the
  codes above. `--only` accepts `event-loop`, `backpressure`, `retry-storm`, `concurrency`,
  `graceful-shutdown`.
- **`doctor`** — checks the Node.js version, platform support, configuration, whether the
  start command exists, and whether the service port is free (a running process on that
  port would otherwise receive the test traffic, so `verify` refuses to start).

A small programmatic API (`runVerify`, `loadConfig`, report types) is exported from the
package for custom runners; it may change before 1.0.

## Limitations

Be aware of what v0.1 does and does not do:

- **Not a proof of production safety.** Passing checks mean the tested scenarios behaved
  correctly on this run, nothing more.
- **HTTP services only.** Targets must be reachable over `http://`; HTTPS targets and
  non-HTTP protocols (gRPC, WebSockets, queues) are not supported yet.
- **One Node.js process.** The first process that answers the health check is the one that
  is measured and signalled. Cluster mode (several workers) and PM2 cluster are not
  specifically supported.
- **The service must run on Node.js** and must not overwrite `NODE_OPTIONS` in its start
  command, otherwise the agent cannot load (checks that need it report an error).
- **Backpressure detection** covers `Writable`, `Duplex` (sockets, transforms, zlib) and HTTP
  responses/requests. Classes that override `write()` without calling the original, and
  writes made synchronously inside another stream's `write()` implementation, are not seen.
  Source attribution relies on stack traces; minified or bundled code gives less useful
  locations (source maps help, e.g. `--enable-source-maps`).
- **Retry timing heuristics** are inferred from aggregate timing at the proxy and can be
  wrong, especially with low concurrency. Only the amplification ratio drives a failure.
- **The fault proxy** handles one HTTP dependency per run, configured through an environment
  variable read by the service. Services that hard-code dependency URLs cannot be tested.
- **Concurrency invariant testing** only checks the invariant you specify, for the
  interleavings that occurred. It does not find race conditions on its own.
- **Graceful shutdown** is skipped on Windows. Other checks work there, but Windows is not
  part of the CI matrix yet.
- **Timing thresholds** depend on the machine. Leave headroom in CI.

## How it compares

ResilienceCheck is deliberately narrow. It complements these tools rather than replacing them:

| Tool category                                      | Focus                                      | Relationship                                                                 |
| -------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Load testers (k6, autocannon, Artillery)           | Throughput and latency under traffic       | ResilienceCheck generates only enough traffic to exercise a failure mode     |
| Network fault proxies (Toxiproxy)                  | Realistic network faults between services  | Its built-in proxy is minimal and HTTP-only; use Toxiproxy for rich faults   |
| Profilers (Clinic.js, `--cpu-prof`)                | Explaining where time and memory go        | ResilienceCheck turns specific behaviours into pass/fail results for CI      |
| Chaos platforms (Chaos Mesh, LitmusChaos, Gremlin) | Faults in real clusters and infrastructure | ResilienceCheck runs locally or in CI against one service; no cluster needed |
| APM and observability (OpenTelemetry, APM vendors) | Watching production                        | ResilienceCheck runs before production and collects nothing                  |

## Roadmap

None of the following is implemented. They are ideas for future versions, roughly in order
of interest:

- HTTP timeout propagation and aborted-request propagation checks
- Circuit-breaker verification
- Database connection pool saturation
- RabbitMQ duplicate-delivery testing
- Kafka out-of-order event testing
- BullMQ job retry behaviour
- Docker Compose topology testing
- Toxiproxy integration for richer network faults
- JUnit output for CI dashboards
- A GitHub Action wrapper

Suggestions and use cases are welcome in the issue tracker.

## Contributing

Contributions are welcome — bug reports, false positives or negatives from real services,
documentation, and new checks. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development
setup (`pnpm install`, `pnpm test`) and the principles every check follows: measure real
behaviour, never fake results, and word uncertain findings as uncertain.

## Security and safe use

ResilienceCheck is meant for local development, CI and staging environments — systems you
own or are explicitly authorized to test. It starts the service itself and binds everything
it creates (reporter, agent control channel, fault proxy) to `127.0.0.1`. It does not send
data anywhere, has no telemetry, performs no destructive operations by default, and does not
store request bodies. Do not point it at systems you are not allowed to test. See
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
