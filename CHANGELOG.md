# Changelog

## 0.3.0

### Features

- **`maxListeners` option** — Cap the number of concurrent resume listener channels per stream (default: 5). Oldest listeners are evicted when the limit is reached, preventing unbounded growth from dead consumers.
- **`maxResumableSize` option** — Limit the size of accumulated stream data eligible for resume replay (default: 2 MB). When exceeded, new resume consumers receive a DONE signal and must re-fetch from the database.

### Improvements

- Replaced `chunks[]` array with a single `joinedCache` string for the in-memory replay buffer, reducing allocations and simplifying the replay path.

## 0.2.0

### Features

- **`sentinelTTL` option** — Make the sentinel key TTL configurable (default: 7200s / 2 hours). Useful for long-running streams like deep research.
- **Generic entry point** (`resuming-stream/generic`) for custom Redis-like clients that don't use ioredis or node-redis.

### Fixes

- Fix cancel handler that killed the producer on client disconnect.
- Resolve remaining memory leaks and cleanup issues.
- Resolve hanging `waitUntil` promises on client disconnect and stream errors.
- Fix ioredis adapter memory leak.
- Fix double-connect when using default clients for ioredis.

## 0.1.0

### Features

- Initial release with `createResumableStreamContext` for ioredis and node-redis.
- `resumeStream` helper for reconnecting clients.
- `hasExistingStream` API to check for in-progress streams.
- Serverless-friendly design with `waitUntil` support.
- Separate `/ioredis` and `/redis` export paths.
