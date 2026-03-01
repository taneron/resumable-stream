# resuming-stream

Library for wrapping streams of strings (like SSE web responses) so that a client can resume them after losing a connection, or a second client can follow along.

Designed for use in serverless environments without sticky load balancing.

Relies on Redis pub/sub. Minimizes latency and Redis usage for the common case where stream recovery isn't needed — in that case, the library performs a single `INCR` and `SUBSCRIBE` per stream.

## Installation

```bash
# npm
npm install resuming-stream

# bun
bun add resuming-stream

# pnpm
pnpm add resuming-stream

# yarn
yarn add resuming-stream
```

You also need a Redis client:

```bash
# Option A: node-redis (official)
npm install redis

# Option B: ioredis
npm install ioredis
```

## Quick start

```typescript
import { createResumableStreamContext } from "resuming-stream";
import { after } from "next/server";

// Uses the `redis` package by default.
// Connects via REDIS_URL or KV_URL environment variable.
const streamContext = createResumableStreamContext({
  waitUntil: after,
});
```

## Usage

### Entry points

| Import path | Redis client | Notes |
|---|---|---|
| `resuming-stream` | `redis` (node-redis) | Auto-connects via `REDIS_URL` / `KV_URL` |
| `resuming-stream/ioredis` | `ioredis` | Auto-connects via `REDIS_URL` / `KV_URL` |
| `resuming-stream/generic` | Any | You provide `publisher` and `subscriber` (required) |

### Idempotent API

Handles both creating and resuming a stream in a single call. Best for simple use cases.

```typescript
import { createResumableStreamContext } from "resuming-stream";
import { after } from "next/server";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const resumeAt = req.nextUrl.searchParams.get("resumeAt");
  const stream = await streamContext.resumableStream(
    streamId,
    makeTestStream,
    resumeAt ? parseInt(resumeAt) : undefined
  );
  if (!stream) {
    return new Response("Stream is already done", {
      status: 422,
    });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}
```

### Explicit create / resume

Separate endpoints for creating and resuming. Gives you more control.

```typescript
import { createResumableStreamContext } from "resuming-stream";
import { after } from "next/server";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});

// POST creates the stream
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  const stream = await streamContext.createNewResumableStream(streamId, makeTestStream);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

// GET resumes it
export async function GET(req: NextRequest, { params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const resumeAt = req.nextUrl.searchParams.get("resumeAt");
  const stream = await streamContext.resumeExistingStream(
    streamId,
    resumeAt ? parseInt(resumeAt) : undefined
  );
  if (!stream) {
    return new Response("Stream is already done", {
      status: 422,
    });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}
```

### With ioredis

```typescript
import { createResumableStreamContext } from "resuming-stream/ioredis";

const streamContext = createResumableStreamContext({
  waitUntil: after,
});
```

Or pass your own instances (use separate clients for pub and sub):

```typescript
import { createResumableStreamContext } from "resuming-stream/ioredis";
import Redis from "ioredis";

const redisSub = new Redis("redis://localhost:6379");
const redisPub = new Redis("redis://localhost:6379");

const streamContext = createResumableStreamContext({
  waitUntil: after,
  subscriber: redisSub,
  publisher: redisPub,
});
```

### With custom Redis clients (generic)

For any Redis-compatible client. Both `publisher` and `subscriber` are required.

```typescript
import { createResumableStreamContext } from "resuming-stream/generic";
import type { Publisher, Subscriber } from "resuming-stream/generic";

const publisher: Publisher = {
  connect: async () => {},
  publish: async (channel, message) => { /* ... */ },
  set: async (key, value, options) => { /* ... */ },
  get: async (key) => { /* ... */ },
  incr: async (key) => { /* ... */ },
};

const subscriber: Subscriber = {
  connect: async () => {},
  subscribe: async (channel, callback) => { /* ... */ },
  unsubscribe: async (channel) => { /* ... */ },
};

const streamContext = createResumableStreamContext({
  waitUntil: after,
  publisher,
  subscriber,
});
```

### Check stream state

```typescript
const state = await streamContext.hasExistingStream(streamId);
// null    — no stream with this ID
// true    — stream is active
// "DONE"  — stream completed (expires after 24h)
```

## Redis requirements

This library requires **real Redis pub/sub over persistent TCP connections**. HTTP-based Redis proxies (like `@upstash/redis`) will not work because they don't support pub/sub.

If you're using a managed Redis provider (Upstash, AWS ElastiCache, etc.), connect with `ioredis` or `redis` via the standard `rediss://` endpoint — not an HTTP SDK.

**Important:** Always use separate Redis client instances for publisher and subscriber. A single client cannot be used for both pub/sub and regular commands simultaneously.

## How it works

1. The first time a resumable stream is invoked for a given `streamId`, a standard stream is created. This becomes the **producer**.
2. The producer always runs the stream to completion, even if the original reader disconnects.
3. The producer listens on pub/sub for additional consumers.
4. When a second stream is invoked for the same `streamId`, it publishes a message to the producer requesting the stream.
5. The producer replays buffered chunks and forwards new chunks via pub/sub.
6. On completion or cancellation, both producer and consumer streams clean up their subscriptions.

## Changelog

### 0.1.0

Based on [vercel/resumable-stream](https://github.com/vercel/resumable-stream) v2.2.10 with the following fixes:

**Bug fixes:**

- **`resumeStream` subscription leak on cancel** — Consumer-side streams created by `resumeExistingStream` / `resumableStream` were missing a `cancel()` handler. When a client disconnected, the Redis pub/sub subscription for that consumer was never cleaned up. Fixed by hoisting cleanup above the `ReadableStream` constructor and adding a `cancel()` handler with an idempotency guard.

- **`createNewResumableStream` hanging `waitUntil` promises** — Producer-side streams didn't handle client disconnects or source stream errors. The `waitUntil` promise would hang forever, blocking serverless function shutdown. Fixed by adding a `cancel()` handler (for client disconnect) and a `.catch()` on the read loop (for source errors), both calling `performCleanup()`.

- **`hasExistingStream` race condition** — `hasExistingStream` didn't await Redis client initialization (`initPromises`). Calling it immediately after construction could fail if Redis connections weren't ready yet.

**Cleanup:**

- Removed unused `skipCharacters` parameter from `createNewResumableStream`.

## Type docs

[Type Docs](https://github.com/taneron/resumable-stream/blob/main/docs/README.md)
