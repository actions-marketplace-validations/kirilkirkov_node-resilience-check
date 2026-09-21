# broken-service

A small HTTP service with **one intentional resilience bug per ResilienceCheck check**. Each
bug is marked with a `BUG:` comment in the source. The same service with the bugs fixed lives
in [`../fixed-service`](../fixed-service); [`../README.md`](../README.md) explains every bug and
fix.

```bash
# from the repository root
pnpm demo
```

Or start it on its own with `npm start` (listens on `127.0.0.1:3100`, fake payments API on
`127.0.0.1:4100`; override with `PORT` and `PAYMENTS_PORT`).

Do not copy this code into a real service.
