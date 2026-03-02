# resuming-stream

Library for wrapping streams of strings (like SSE web responses) so that a client can resume them after losing a connection, or a second client can follow along.

Works in both serverless (Vercel, AWS Lambda, Cloudflare Workers) and traditional server environments (Express, Fastify, long-lived Node.js processes). Uses Redis pub/sub as a shared backplane so reconnecting clients can resume from any server instance — no sticky load balancing required.

Minimizes latency and Redis usage for the common case where stream recovery isn't needed — in that case, the library performs a single `INCR` and `SUBSCRIBE` per stream.

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

### Serverless (Next.js, Vercel)

```typescript
import { createResumableStreamContext } from "resuming-stream";
import { after } from "next/server";

// waitUntil keeps the serverless function alive until the producer finishes
const streamContext = createResumableStreamContext({
  waitUntil: after,
});
```

### Traditional server (Express, Fastify, etc.)

```typescript
import { createResumableStreamContext } from "resuming-stream";

// Pass null — long-lived processes don't need waitUntil
const streamContext = createResumableStreamContext({
  waitUntil: null,
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
// "DONE"  — stream completed (expires after sentinelTTL, default 2h)
```

## Memory profile

Compared against the original `resumable-stream` over a 5-minute stress test on Node.js (100 concurrent streams, 1 MB chunks):

| Metric | resumable-stream | resuming-stream | Difference |
|---|---|---|---|
| Final RSS | 585 MB | 385 MB | **-34%** |
| RSS Growth | +196 MB | -1 MB | Original leaks ~38 MB/min, fork is flat |
| Final Heap Used | 267 MB | 151 MB | **-43%** |
| External Growth | +4 MB | 0 MB | Fork cleans up Buffers properly |

The original grew 196 MB in ~5 minutes and never came back down. The fork returned to baseline after idle.

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

### 0.2.0

**Bug fixes:**

- **Producer no longer killed on client disconnect** — The `cancel()` handler on the producer-side ReadableStream was incorrectly stopping the source stream and marking the sentinel as DONE when a client disconnected. This broke the core resumable behavior. The producer now continues to completion regardless of consumer disconnects.

- **Source stream errors now trigger cleanup** — Added `.catch()` on the read loop so that if the source stream (e.g. LLM provider) errors, the `waitUntil` promise resolves, the sentinel is set to DONE, and buffered chunks are freed.

- **`chunks[]` and `listenerChannels[]` cleared after completion** — These arrays are now zeroed out in `performCleanup()`, preventing memory leaks when frameworks (e.g. Next.js `after()`) hold references to the stream or its promises.

- **`resumeStream` timeout no longer hangs** — The timeout handler now always calls `resolve(null)`, preventing the returned promise from hanging forever when no producer responds.

**Features:**

- **Configurable sentinel TTL** — New `sentinelTTL` option (in seconds) controls how long Redis sentinel keys persist. Defaults to 2 hours (down from 24h). Increase for long-running streams like deep research.

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
