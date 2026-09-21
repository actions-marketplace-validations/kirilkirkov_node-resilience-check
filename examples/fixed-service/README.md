# fixed-service

The same endpoints as [`../broken-service`](../broken-service), with every resilience bug
fixed. Each fix is marked with a `FIX:` comment in the source. [`../README.md`](../README.md)
compares the two.

```bash
# from the repository root
pnpm demo:fixed
```

Or start it on its own with `npm start` (listens on `127.0.0.1:3200`, fake payments API on
`127.0.0.1:4200`; override with `PORT` and `PAYMENTS_PORT`).
