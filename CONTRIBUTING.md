# Contributing to ResilienceCheck

Thanks for your interest! Bug reports, false positives/negatives from real services,
documentation fixes and new checks are all welcome.

## Development setup

Requirements: Node.js 22.12+ and pnpm (the version is pinned in `package.json`; with
Corepack enabled, `pnpm` picks it up automatically).

```bash
pnpm install
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # strict TypeScript over src/ and tests/
pnpm test        # unit + integration tests (integration builds dist/ first)
pnpm build       # compiles to dist/
pnpm build:action # rebuilds the GitHub Action bundle in dist/action/; commit the result
pnpm demo        # runs the CLI against examples/broken-service
```

Useful while iterating:

```bash
pnpm test:unit
pnpm test:integration
pnpm format
node dist/cli/index.js verify --config examples/broken-service/resiliencecheck.config.json --verbose
```

The test suite needs no internet access. Integration tests use random free ports and run
one file at a time, because several checks measure timing.

## Project layout

```text
src/
├── cli/          commander setup and the init / verify / doctor commands
├── config/       types, validation with readable messages, init template
├── agent/        preload agent loaded into the service (keep it small and dependency-free)
├── checks/       one file per check: scenario runner + pure evaluate function
├── analysis/     pure heuristics (retry timing)
├── runner/       service lifecycle, reporter server, fault proxy, orchestration, report
├── http/         HTTP clients: load, slow reader, simultaneous requests
├── reporter/     terminal and JSON output
└── shared/       code used by both the CLI and the agent
tests/
├── unit/
└── integration/  runs the built CLI against examples/
examples/
├── broken-service/
└── fixed-service/
scripts/
└── demo.mjs      used by `pnpm demo` / `pnpm demo:fixed`
```

## Principles for checks

ResilienceCheck is only useful if its results can be trusted. Every check follows these rules:

1. **Measure real behaviour.** Checks provoke the condition for real — real sockets, real
   signals, real processes. No simulated results.
2. **Report only what was measured.** Where a conclusion is inferred (for example retry
   jitter from aggregate timing), label it as a heuristic and phrase it cautiously
   ("possible", "no … was observed").
3. **Do not pass silently when the scenario did not exercise the behaviour.** Warn instead
   (for example, when `write()` never returned `false`).
4. **Never change application behaviour.** Instrumentation must preserve return values,
   errors and semantics, must not add routes, and must not keep the process alive.
5. **Always clean up.** Processes, timers, sockets, servers and listeners — on success,
   failure and Ctrl+C.
6. **Keep evaluation pure.** Each check exposes an `evaluate…` function over plain metrics so
   verdicts can be unit tested without starting a service.
7. **Stay local.** Nothing leaves `127.0.0.1`. No telemetry.

A new check usually needs: a config section in `src/config/` (types, validation, docs in
`docs/configuration.md`), a check module in `src/checks/`, an entry in
`src/runner/plan.ts`, unit tests for its evaluator, a broken/fixed endpoint pair in the
examples, and integration test assertions.

## Code style

- Strict TypeScript, ESM, Node built-ins first. Avoid new runtime dependencies.
- No `any` unless unavoidable (and then documented).
- Small modules and plain functions; classes only where they hold real state.
- Comments explain _why_, not _what_.
- Prettier formats everything; run `pnpm format`.

## Pull requests

- Keep PRs focused; open an issue first for larger changes or new checks.
- Add or update tests. `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass.
- Update `README.md`, `docs/` and `CHANGELOG.md` for user-facing changes.

## Releasing (maintainers)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
npm version <patch|minor|major>   # updates package.json and creates a tag
npm publish --access public       # prepublishOnly runs the full pipeline again
git push --follow-tags
```

Move the `Unreleased` entries in `CHANGELOG.md` under the new version before tagging.

By contributing you agree that your contributions are licensed under the MIT License.
