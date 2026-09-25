# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- GitHub Action (`uses: kirilkirkov/node-resilience-check@v1`) with `config`, `only`, `seed`,
  `verbose` and `report-path` inputs and `exit-code` / `report-path` outputs. It wraps
  `resilience-check verify` and ships as a self-contained bundle in `dist/action/`.

## [0.1.0] - Unreleased

First public version.

### Added

- `resilience-check verify`: starts the service with a preload agent (`NODE_OPTIONS=--import`),
  waits for its health check, runs the enabled checks, prints results as they arrive and
  exits with `0`, `1`, `2` or `130` for CI.
- Event loop check: event-loop delay (mean, p50, p95, p99, max) and utilization measured with
  `monitorEventLoopDelay()` while loading an endpoint.
- Backpressure check: a slow-reading client plus `write()` instrumentation for `Writable`,
  `Duplex` and `http.OutgoingMessage` that counts writes made while waiting for `'drain'` and
  reports the application source location.
- Retry behavior check: a localhost HTTP fault proxy (`status` and `reset` faults) injected via
  an environment variable; retry amplification plus heuristics for missing jitter and backoff.
- Concurrency invariant testing: simultaneous requests via pre-opened connections, success
  assertions, optional setup request, rounds and seeded jitter (`--seed`).
- Graceful shutdown check: `SIGTERM`/`SIGINT` to the Node.js process serving HTTP while
  requests are in flight; completed, failed and dropped requests, exit time, missing handler.
- `resilience-check init` with start-command detection, and `resilience-check doctor`.
- Readable configuration validation with "did you mean" suggestions.
- Versioned JSON report (`--json`), automatic plain output without a TTY or with `NO_COLOR`.
- Runnable `broken-service` and `fixed-service` examples.

[Unreleased]: https://github.com/kirilkirkov/node-resilience-check/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kirilkirkov/node-resilience-check/releases/tag/v0.1.0
