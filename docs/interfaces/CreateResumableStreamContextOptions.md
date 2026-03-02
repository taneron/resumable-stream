[**Resumable Stream v0.3.0**](../README.md)

***

[Resumable Stream](../README.md) / CreateResumableStreamContextOptions

# Interface: CreateResumableStreamContextOptions

## Properties

### keyPrefix?

> `optional` **keyPrefix**: `string`

The prefix for the keys used by the resumable streams. Defaults to `resumable-stream`.

***

### maxListeners?

> `optional` **maxListeners**: `number`

Maximum number of concurrent resume listener channels per stream.
Oldest listeners are evicted when this limit is reached.
Defaults to 5.

***

### maxResumableSize?

> `optional` **maxResumableSize**: `number`

Maximum size in bytes of accumulated stream data eligible for resume replay.
When exceeded, new resume consumers receive a DONE signal and must re-fetch from the database.
Defaults to 2 MB (2 * 1024 * 1024).

***

### publisher?

> `optional` **publisher**: `Redis` \| [`Publisher`](Publisher.md)

A pubsub publisher. Designed to be compatible with clients from the `redis` package.

***

### sentinelTTL?

> `optional` **sentinelTTL**: `number`

TTL in seconds for the Redis sentinel keys that track stream state.
Defaults to 7200 (2 hours). Increase for long-running streams like deep research.

***

### subscriber?

> `optional` **subscriber**: [`Subscriber`](Subscriber.md) \| `Redis`

A pubsub subscriber. Designed to be compatible with clients from the `redis` package.

***

### waitUntil

> **waitUntil**: `null` \| (`promise`) => `void`

A function that takes a promise and ensures that the current program stays alive
until the promise is resolved.

If you are deploying to a server environment, where you don't have to worry about
the function getting suspended, pass in null.
