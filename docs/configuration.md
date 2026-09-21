# Configuration reference

ResilienceCheck reads `resiliencecheck.config.json` from the current directory, or the file
passed with `--config <path>`. JSON cannot contain comments, so every option is documented
here. Run `resilience-check init` to generate a starting point.

- [File layout](#file-layout)
- [`service`](#service)
- [Request fields](#request-fields)
- [`checks.eventLoop`](#checkseventloop)
- [`checks.backpressure`](#checksbackpressure)
- [`checks.retryStorm`](#checksretrystorm)
- [`checks.concurrency`](#checksconcurrency)
- [`checks.gracefulShutdown`](#checksgracefulshutdown)
- [Environment seen by the service](#environment-seen-by-the-service)
- [Validation errors](#validation-errors)

## File layout

```json
{
  "service": { "…": "how to start and reach the service" },
  "checks": {
    "eventLoop": {},
    "backpressure": {},
    "retryStorm": {},
    "concurrency": [],
    "gracefulShutdown": {}
  }
}
```

- A check runs when its section is present and `enabled` is not `false`.
- A section with `"enabled": false` is not validated further, so it can hold unfinished
  placeholders.
- At least one check must be enabled.
- Unknown keys are rejected with a suggestion for the closest known key.
- A top-level `"$schema"` key is allowed and ignored.
- Checks always run in this order: event loop, backpressure, retry behavior, concurrency
  scenarios, graceful shutdown (last, because it stops the service).

All durations are in milliseconds.

## `service`

| Option             | Type   | Default          | Description                                                                                             |
| ------------------ | ------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `command`          | string | **required**     | Shell command that starts the service, e.g. `"node dist/server.js"` or `"npm start"`.                   |
| `baseUrl`          | string | **required**     | Where the service listens, e.g. `"http://127.0.0.1:3000"`. Must be `http://`; a path prefix is allowed. |
| `healthPath`       | string | `"/health"`      | Polled until it returns 2xx. The service counts as started only then.                                   |
| `startupTimeoutMs` | number | `10000`          | How long to wait for the health check before giving up.                                                 |
| `cwd`              | string | config directory | Working directory for `command`, relative to the config file.                                           |
| `env`              | object | `{}`             | Extra environment variables (string values) for the service.                                            |

Notes:

- The command runs through a shell in its own process group. When ResilienceCheck finishes
  (or is interrupted) the whole group is stopped: `SIGTERM`, then `SIGKILL` after 3 seconds.
- `verify` refuses to start if something is already listening on `baseUrl`; the traffic would
  otherwise go to the wrong process.
- Package-manager wrappers such as `npm start` work: the agent identifies the Node.js process
  that answers the health check, and signals are sent to that process directly.
- File paths in reports are shown relative to `cwd`.

## Request fields

Every check that sends requests accepts these fields — directly in the check section
(`eventLoop`, `backpressure`, `gracefulShutdown`, `retryStorm.trigger`) or inside a `request`
/ `setup` object (`concurrency`).

| Option    | Type           | Default      | Description                                                                                           |
| --------- | -------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `method`  | string         | `"GET"`      | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS` (case-insensitive).                      |
| `path`    | string         | **required** | Must start with `/`. Appended to `service.baseUrl`. May include a query string.                       |
| `headers` | object         | `{}`         | Extra request headers (string values).                                                                |
| `body`    | string or JSON | none         | Strings are sent as `text/plain`, anything else as JSON — unless you set `content-type` in `headers`. |

## `checks.eventLoop`

Measures event-loop delay inside the service while sending load to one endpoint.

| Option         | Type    | Default | Description                                              |
| -------------- | ------- | ------- | -------------------------------------------------------- |
| `enabled`      | boolean | `true`  |                                                          |
| request fields |         |         | The endpoint to load; `path` is required.                |
| `requests`     | integer | `20`    | Total requests to send.                                  |
| `concurrency`  | integer | `5`     | Requests in flight at once.                              |
| `maxP99Ms`     | number  | `100`   | Fail when the p99 event-loop delay is above this value.  |
| `resolutionMs` | integer | `10`    | Sampling resolution passed to `monitorEventLoopDelay()`. |
| `timeoutMs`    | number  | `10000` | Per-request timeout.                                     |

Result: **fail** above `maxP99Ms`; **error** if every request failed (the loop was not measured
under realistic load); **warn** if no samples were collected.

## `checks.backpressure`

Streams a response to a client that deliberately stops reading, and counts `write()` calls the
service makes after `write()` returned `false` and before `'drain'`.

| Option             | Type    | Default | Description                                                           |
| ------------------ | ------- | ------- | --------------------------------------------------------------------- |
| `enabled`          | boolean | `true`  |                                                                       |
| request fields     |         |         | An endpoint that streams a large response; `path` is required.        |
| `requests`         | integer | `1`     | Slow clients to run in parallel (1–50).                               |
| `holdMs`           | integer | `1000`  | How long each client stops reading before draining the response.      |
| `maxIgnoredWrites` | integer | `0`     | Fail when more writes than this happened while waiting for `'drain'`. |
| `timeoutMs`        | number  | `30000` | Maximum time for each slow client to receive the full response.       |

Result: **fail** above `maxIgnoredWrites`; **warn** if `write()` never returned `false` (the
response was too small, or `holdMs` too short, to exercise backpressure); **error** if the
slow client never got a response.

The endpoint must produce more data than the socket buffers hold — typically several
megabytes on localhost.

## `checks.retryStorm`

Makes one downstream dependency fail and measures how many attempts the service makes.

| Option                | Type    | Default          | Description                                                                               |
| --------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `enabled`             | boolean | `true`           |                                                                                           |
| `dependency.env`      | string  | **required**     | Environment variable the service reads the dependency URL from, e.g. `"PAYMENTS_URL"`.    |
| `dependency.target`   | string  | **required**     | The real dependency URL (`http://`). Used for forwarding outside the fault window.        |
| `trigger`             | object  | **required**     | Request fields for the endpoint that calls the dependency; `path` is required.            |
| `trigger.requests`    | integer | `20`             | Incoming requests to send.                                                                |
| `trigger.concurrency` | integer | same as requests | Incoming requests in flight at once.                                                      |
| `trigger.timeoutMs`   | number  | `30000`          | Per-request timeout.                                                                      |
| `fault.type`          | string  | `"status"`       | `"status"` answers with an HTTP status; `"reset"` resets the TCP connection.              |
| `fault.status`        | integer | `503`            | Status code for `"status"` faults (400–599).                                              |
| `fault.durationMs`    | integer | `3000`           | How long the fault lasts, from the moment the trigger requests start.                     |
| `maxAmplification`    | number  | `3`              | Fail when downstream attempts ÷ incoming requests is above this value.                    |
| `settleMs`            | integer | `500`            | Extra time to keep counting after the last trigger response (catches background retries). |

How it works: ResilienceCheck starts a proxy on `127.0.0.1` and sets `dependency.env` to the
proxy's URL **in the service's environment only**. The service must read that variable (at
startup or per request). The proxy forwards to `dependency.target`, keeping the target's path
prefix, except during the fault window.

Result: **fail** above `maxAmplification`; **warn** when amplification is acceptable but
retries arrived in synchronized bursts; **error** if no attempt reached the proxy.

The jitter and backoff findings are heuristics based on when attempts reached the proxy (see
the README). They never cause a failure on their own.

## `checks.concurrency`

An array of scenarios. Each sends the same request many times, simultaneously, and checks
how many succeeded.

| Option                | Type             | Default      | Description                                                                                         |
| --------------------- | ---------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `enabled`             | boolean          | `true`       |                                                                                                     |
| `name`                | string           | **required** | Unique; shown as `Concurrency: <name>`.                                                             |
| `request`             | object           | **required** | Request fields; `path` is required.                                                                 |
| `requests`            | integer          | `10`         | Simultaneous requests per round (2–1000).                                                           |
| `rounds`              | integer          | `1`          | How many times to repeat the scenario (1–100). Fails if any round violates the assertion.           |
| `jitterMs`            | integer          | `0`          | Delay each request by a random 0…`jitterMs` ms (seeded). `0` fires all at once.                     |
| `setup`               | object           | none         | Request fields for a request sent before each round, e.g. a test-only reset endpoint. Must succeed. |
| `timeoutMs`           | number           | `10000`      | Per-request timeout.                                                                                |
| `assert.status`       | integer or array | any 2xx      | Which statuses count as a success.                                                                  |
| `assert.maxSuccesses` | integer          | none         | Fail when more requests succeed. Cannot exceed `requests`.                                          |
| `assert.minSuccesses` | integer          | none         | Fail when fewer requests succeed.                                                                   |

At least one of `maxSuccesses` / `minSuccesses` is required.

Randomness: `jitterMs` delays come from a generator seeded with the run's seed (printed on
every run, settable with `--seed`) combined with the scenario name. The same seed and
configuration produce the same delays.

This is **concurrency invariant testing**, not general race-condition detection: it checks
the property you specify, for the interleavings that happened in the run.

## `checks.gracefulShutdown`

Sends requests, then a termination signal while they are in flight. Runs last, because it
stops the service. Skipped on Windows.

| Option               | Type    | Default     | Description                                                                                  |
| -------------------- | ------- | ----------- | -------------------------------------------------------------------------------------------- |
| `enabled`            | boolean | `true`      |                                                                                              |
| request fields       |         |             | Preferably a slow endpoint, so requests are still running at the signal; `path` is required. |
| `concurrency`        | integer | `10`        | Requests to start before the signal.                                                         |
| `signal`             | string  | `"SIGTERM"` | `"SIGTERM"` or `"SIGINT"`.                                                                   |
| `signalAfterMs`      | integer | `100`       | Delay between "requests confirmed in flight" and sending the signal.                         |
| `shutdownTimeoutMs`  | number  | `5000`      | Fail if the process is still running this long after the signal (it is then killed).         |
| `maxDroppedRequests` | integer | `0`         | Fail when more requests than this were dropped or answered with 5xx.                         |

Result: **fail** when the process outlived `shutdownTimeoutMs` or lost too many requests;
**warn** when no request was in flight at the signal (use a slower endpoint).

## Environment seen by the service

ResilienceCheck starts the service with your environment plus:

| Variable                      | Value                                                                 |
| ----------------------------- | --------------------------------------------------------------------- |
| everything in `service.env`   | as configured                                                         |
| `NODE_OPTIONS`                | your existing value, followed by `--import=<agent>`                   |
| `<retryStorm.dependency.env>` | the fault proxy URL, when the retry check is enabled                  |
| `RESILIENCE_CHECK_REPORTER`   | the CLI's localhost reporter URL                                      |
| `RESILIENCE_CHECK_TOKEN`      | a random per-run token authenticating the agent and CLI to each other |
| `RESILIENCE_CHECK_FEATURES`   | optional agent features, e.g. `backpressure`                          |

If your start command replaces `NODE_OPTIONS` instead of extending it, the agent cannot load.

## Validation errors

Problems are listed one per line, all at once:

```text
✗ Invalid configuration (./resiliencecheck.config.json):

    service.baseUrl must be a valid URL such as "http://127.0.0.1:3000" (got "localhost:3000").
    checks.eventLoop.maxP99Ms must be greater than 0.
    checks.eventLoop.maxP99 is not a known option. Did you mean "maxP99Ms"?
    checks.concurrency[0].assert must set maxSuccesses and/or minSuccesses.
```

`verify` exits with code `2` when the configuration is invalid. `resilience-check doctor`
validates the configuration without starting the service.
