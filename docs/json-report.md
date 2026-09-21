# JSON report

`resilience-check verify --json <path>` writes a report meant for CI tooling. The shape is
versioned by `schemaVersion`; fields are only added within a schema version, and any
breaking change increments it. TypeScript types are exported from the package
(`RunReport`, `CheckResult`, `EventLoopMetrics`, …).

The report never contains request or response bodies. Paths recorded by the fault proxy
exclude query strings.

## Top level

| Field           | Type                       | Description                                                                               |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `schemaVersion` | number                     | Currently `1`.                                                                            |
| `tool`          | `{ name, version }`        | `node-resilience-check` and its version.                                                  |
| `version`       | string                     | Same as `tool.version`.                                                                   |
| `seed`          | number                     | Seed used for randomized scheduling; pass it to `--seed` to reproduce.                    |
| `startedAt`     | string                     | ISO 8601.                                                                                 |
| `finishedAt`    | string                     | ISO 8601.                                                                                 |
| `durationMs`    | number                     | Whole run, including service startup and shutdown.                                        |
| `environment`   | `{ node, platform, arch }` | Where the run happened.                                                                   |
| `service`       | object                     | `command`, `baseUrl`, `pid` (the Node.js process that served HTTP) and `agent` (boolean). |
| `summary`       | object                     | `total`, `passed`, `failed`, `warnings`, `skipped`, `errors`.                             |
| `exitCode`      | `0 \| 1 \| 2`              | `0` all passed, `1` a check failed or errored, `2` nothing could run (or interrupted).    |
| `aborted`       | boolean                    | True when interrupted (the CLI exits with 130).                                           |
| `fatalError`    | object or null             | `{ message, serviceOutput: string[] }` when the service could not be started.             |
| `checks`        | array                      | One entry per check (one per concurrency scenario), in execution order.                   |

## Check result

| Field        | Type           | Description                                                                        |
| ------------ | -------------- | ---------------------------------------------------------------------------------- |
| `id`         | string         | `event-loop`, `backpressure`, `retry-storm`, `concurrency` or `graceful-shutdown`. |
| `name`       | string         | Display name, e.g. `Concurrency: reserve-stock`.                                   |
| `status`     | string         | `pass`, `fail`, `warn`, `skip` or `error`.                                         |
| `summary`    | string         | The one-line result shown in the terminal.                                         |
| `details`    | string[]       | The indented lines shown in the terminal.                                          |
| `durationMs` | number         | Time spent in the check.                                                           |
| `metrics`    | object or null | Check-specific measurements (below). `null` when the check could not measure.      |

Statuses: **pass** — within limits. **fail** — a limit was exceeded (or the service crashed
during the check). **warn** — no limit exceeded, but the result needs attention or the
scenario did not exercise the behaviour; does not fail CI. **skip** — did not run.
**error** — no trustworthy result; fails CI.

## Metrics by check

### `event-loop`

| Field                                                             | Description                                      |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `request`                                                         | e.g. `"GET /heavy-report"`                       |
| `requests`, `concurrency`                                         | Scenario size.                                   |
| `succeededRequests`, `failedRequests`                             | 2xx/3xx vs everything else.                      |
| `responses`                                                       | Summary such as `"200×20"`.                      |
| `samples`                                                         | Histogram samples collected.                     |
| `minMs`, `meanMs`, `p50Ms`, `p95Ms`, `p99Ms`, `maxMs`, `stddevMs` | Event-loop delay in milliseconds.                |
| `utilization`                                                     | Event-loop utilization during the scenario, 0–1. |
| `maxP99Ms`                                                        | Configured limit.                                |

### `backpressure`

| Field                                               | Description                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`, `requests`, `holdMs`, `maxIgnoredWrites` | Scenario and limit.                                                                                                                           |
| `backpressureSignals`                               | How often any tracked `write()` returned `false`.                                                                                             |
| `ignoredWrites`                                     | `write()` calls from application or dependency code while waiting for `'drain'`.                                                              |
| `ignoredInternalWrites`                             | Same, made by Node.js internals (not counted as violations).                                                                                  |
| `episodes`                                          | Separate wait-for-drain periods in which writes were ignored.                                                                                 |
| `sites[]`                                           | `{ location, attribution, streamType, ignoredWrites, episodes, stack[] }`, most writes first. `attribution` is `application` or `dependency`. |
| `clients[]`                                         | `{ outcome, status, bytes }` for each slow client.                                                                                            |

### `retry-storm`

| Field                                                        | Description                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`, `dependencyEnv`, `dependencyTarget`, `fault`      | Scenario.                                                                                                                                                                                                                                                                            |
| `incomingRequests`, `downstreamAttempts`                     | Counts.                                                                                                                                                                                                                                                                              |
| `amplification`, `maxAmplification`                          | Ratio and limit.                                                                                                                                                                                                                                                                     |
| `attemptsDuringFault`, `attemptsForwarded`, `upstreamErrors` | What the proxy did with each attempt.                                                                                                                                                                                                                                                |
| `triggerResponses`                                           | What the service answered, e.g. `"502×20"`.                                                                                                                                                                                                                                          |
| `timing`                                                     | Heuristic analysis: `jitter` (`absent`, `present`, `insufficient-data`, `not-applicable`), `backoff` (`immediate`, `constant`, `increasing`, `inconclusive`, `undetermined`, `insufficient-data`, `not-applicable`), `synchronizedShare`, `waves[]`, `waveIntervalsMs[]`, `notes[]`. |

### `concurrency`

| Field                             | Description                                                       |
| --------------------------------- | ----------------------------------------------------------------- |
| `scenario`, `request`, `requests` | Scenario.                                                         |
| `successStatus`                   | List of statuses, or `"2xx"`.                                     |
| `maxSuccesses`, `minSuccesses`    | Assertion (`null` when not set).                                  |
| `jitterMs`, `scenarioSeed`        | Scheduling; `scenarioSeed` is derived from the run seed and name. |
| `rounds[]`                        | `{ round, successes, responses, errors }`.                        |

### `graceful-shutdown`

| Field                                     | Description                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `request`, `signal`, `targetPid`          | Scenario; `targetPid` is the process that received the signal.                  |
| `sent`, `inFlightAtSignal`                | Requests started, and still running when the signal was sent.                   |
| `completed`                               | Full response with status < 500.                                                |
| `failedResponses`                         | Full response with status ≥ 500.                                                |
| `dropped`                                 | No complete response (connection closed, reset or timed out).                   |
| `responses`                               | Summary such as `"200×13, reset×7"`.                                            |
| `exitedAfterMs`, `timedOut`               | Exit time after the signal (`null` when it did not exit in time).               |
| `shutdownTimeoutMs`, `maxDroppedRequests` | Limits.                                                                         |
| `signalHandlers`                          | Listeners the application registered for the signal (`null` without the agent). |

## Example: failing a pipeline step on specific checks

```bash
jq -e '[.checks[] | select(.id == "backpressure" or .id == "event-loop") | select(.status == "fail")] | length == 0' \
  resiliencecheck-report.json
```
