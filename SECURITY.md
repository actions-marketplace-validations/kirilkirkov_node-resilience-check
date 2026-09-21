# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately through
GitHub: **Security → Report a vulnerability** on the
[repository page](https://github.com/kirilkirkov/node-resilience-check/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. You should receive a
response within a few days. Fixes are released as soon as practical, and reporters are
credited unless they prefer otherwise.

## Supported versions

Only the latest released version receives security fixes while the project is below 1.0.

## Security model

ResilienceCheck runs on a developer machine or CI runner and starts the service under test as
a child process. By design:

- Everything it creates — the reporter server, the agent's control server inside the service,
  and the fault proxy — listens on `127.0.0.1` only.
- The CLI and agent authenticate each other with a random per-run token passed through the
  child's environment.
- It sends no data outside the machine and has no telemetry.
- It does not store request or response bodies; the fault proxy records paths without query
  strings.
- It does not perform destructive operations by default. Scenarios send the requests you
  configure — make sure those are safe to repeat against the environment you test.

Things that are **not** considered vulnerabilities:

- Other processes running as the same OS user being able to observe or interfere with a
  local run (they can already read the environment and memory of your processes).
- A service under test behaving badly when tested — that is the point of the tool.

## Safe use

Only run ResilienceCheck against services and environments you own or are explicitly
authorized to test: local development, CI and staging. It is not intended for testing
production systems or third-party services.
