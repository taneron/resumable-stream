import type { Redis } from "ioredis";
import { _Private, Publisher, Subscriber } from "./types";
import { CreateResumableStreamContextOptions } from "./types";
import { ResumableStreamContext } from "./types";
import { createPublisherAdapter, createSubscriberAdapter } from "./ioredis-adapters";

const DEFAULT_SENTINEL_TTL = 2 * 60 * 60; // 2 hours
const DONE_SENTINEL_TTL = 5 * 60; // 5 minutes — completed streams only need brief sentinel for late resume attempts

interface CreateResumableStreamContext {
  keyPrefix: string;
  waitUntil: (promise: Promise<unknown>) => void;
  subscriber: Subscriber;
  publisher: Publisher;
  sentinelTTL: number;
  maxListeners: number;
  maxResumableSize: number;
}

export function createResumableStreamContextFactory(defaults: _Private.RedisDefaults) {
  return function createResumableStreamContext(
    options: CreateResumableStreamContextOptions
  ): ResumableStreamContext {
    const waitUntil = options.waitUntil || (async (p) => await p);
    const ctx = {
      keyPrefix: `${options.keyPrefix || "resumable-stream"}:rs`,
      waitUntil,
      subscriber: options.subscriber,
      publisher: options.publisher,
      sentinelTTL: options.sentinelTTL ?? DEFAULT_SENTINEL_TTL,
      maxListeners: options.maxListeners ?? DEFAULT_MAX_LISTENERS,
      maxResumableSize: options.maxResumableSize ?? DEFAULT_MAX_RESUMABLE_SIZE,
    } as CreateResumableStreamContext;
    let initPromises: Promise<unknown>[] = [];

    // Check if user has passed a raw ioredis instance
    if (options.subscriber && (options.subscriber as Redis).defineCommand) {
      ctx.subscriber = createSubscriberAdapter(options.subscriber as Redis);
    }
    if (options.publisher && (options.publisher as Redis).defineCommand) {
      ctx.publisher = createPublisherAdapter(options.publisher as Redis);
    }

    // If user has passed undefined, initialize with defaults
    if (!ctx.subscriber) {
      ctx.subscriber = defaults.subscriber();
      initPromises.push(ctx.subscriber.connect());
    }
    if (!ctx.publisher) {
      ctx.publisher = defaults.publisher();
      initPromises.push(ctx.publisher.connect());
    }

    return {
      resumeExistingStream: async (
        streamId: string,
        skipCharacters?: number
      ): Promise<ReadableStream<string> | null | undefined> => {
        return resumeExistingStream(
          Promise.all(initPromises),
          ctx as CreateResumableStreamContext,
          streamId,
          skipCharacters
        );
      },
      createNewResumableStream: async (
        streamId: string,
        makeStream: () => ReadableStream<string>
      ): Promise<ReadableStream<string> | null> => {
        const initPromise = Promise.all(initPromises);
        await initPromise;
        await ctx.publisher.set(`${ctx.keyPrefix}:sentinel:${streamId}`, "1", {
          EX: ctx.sentinelTTL,
        });
        return createNewResumableStream(
          initPromise,
          ctx as CreateResumableStreamContext,
          streamId,
          makeStream
        );
      },
      resumableStream: async (
        streamId: string,
        makeStream: () => ReadableStream<string>,
        skipCharacters?: number
      ): Promise<ReadableStream<string> | null> => {
        return createResumableStream(
          Promise.all(initPromises),
          ctx as CreateResumableStreamContext,
          streamId,
          makeStream,
          skipCharacters
        );
      },
      hasExistingStream: async (streamId: string): Promise<null | true | "DONE"> => {
        await Promise.all(initPromises);
        const state = await ctx.publisher.get(`${ctx.keyPrefix}:sentinel:${streamId}`);
        if (state === null) {
          return null;
        }
        if (state === DONE_VALUE) {
          return DONE_VALUE;
        }
        return true;
      },
    } as const;
  };
}

interface ResumeStreamMessage {
  listenerId: string;
  skipCharacters?: number;
}

const DONE_MESSAGE = "\n\n\nDONE_SENTINEL_hasdfasudfyge374%$%^$EDSATRTYFtydryrte\n";

const DONE_VALUE = "DONE";

const DEFAULT_MAX_LISTENERS = 5;
const DEFAULT_MAX_RESUMABLE_SIZE = 2 * 1024 * 1024; // 2 MB

async function resumeExistingStream(
  initPromise: Promise<unknown>,
  ctx: CreateResumableStreamContext,
  streamId: string,
  skipCharacters?: number
): Promise<ReadableStream<string> | null | undefined> {
  await initPromise;
  const state = await ctx.publisher.get(`${ctx.keyPrefix}:sentinel:${streamId}`);
  if (!state) {
    return undefined;
  }
  if (state === DONE_VALUE) {
    return null;
  }
  return resumeStream(ctx, streamId, skipCharacters);
}

async function createNewResumableStream(
  initPromise: Promise<unknown>,
  ctx: CreateResumableStreamContext,
  streamId: string,
  makeStream: () => ReadableStream<string>
): Promise<ReadableStream<string> | null> {
  await initPromise;
  let joinedCache = "";
  let listenerChannels: string[] = [];
  let streamDoneResolver: (() => void) | undefined;
  ctx.waitUntil(
    new Promise<void>((resolve) => {
      streamDoneResolver = resolve;
    })
  );
  let isDone = false;
  let cleanedUp = false;

  async function performCleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    isDone = true;
    const promises: Promise<unknown>[] = [];
    debugLog("setting sentinel to done");
    promises.push(
      ctx.publisher
        .set(`${ctx.keyPrefix}:sentinel:${streamId}`, DONE_VALUE, {
          EX: DONE_SENTINEL_TTL,
        })
        .catch(() => {})
    );
    promises.push(
      ctx.subscriber.unsubscribe(`${ctx.keyPrefix}:request:${streamId}`).catch(() => {})
    );
    for (const listenerId of listenerChannels) {
      debugLog("sending done message to", listenerId);
      promises.push(
        ctx.publisher
          .publish(`${ctx.keyPrefix}:chunk:${listenerId}`, DONE_MESSAGE)
          .catch(() => {})
      );
    }
    await Promise.all(promises);
    joinedCache = "";
    listenerChannels.length = 0;
    streamDoneResolver?.();
    streamDoneResolver = undefined;
    debugLog("Cleanup done");
  }

  // This is ultimately racy if two requests for the same ID come at the same time.
  // But this library is for the case where that would not happen.
  await ctx.subscriber.subscribe(
    `${ctx.keyPrefix}:request:${streamId}`,
    async (message: string) => {
      const parsedMessage = JSON.parse(message) as ResumeStreamMessage;
      debugLog("Connected to listener", parsedMessage.listenerId);

      // Cap listener channels to prevent unbounded growth from dead consumers
      if (listenerChannels.length >= ctx.maxListeners) {
        listenerChannels.splice(0, listenerChannels.length - ctx.maxListeners + 1);
      }
      listenerChannels.push(parsedMessage.listenerId);

      // If accumulated data is too large, don't replay — client should re-fetch from DB
      if (joinedCache.length > ctx.maxResumableSize) {
        debugLog("Stream exceeds maxResumableSize (" + ctx.maxResumableSize + " bytes), sending DONE");
        await ctx.publisher.publish(
          `${ctx.keyPrefix}:chunk:${parsedMessage.listenerId}`,
          DONE_MESSAGE
        );
        return;
      }

      debugLog("parsedMessage", joinedCache.length, parsedMessage.skipCharacters);
      const chunksToSend = joinedCache.slice(parsedMessage.skipCharacters || 0);
      debugLog("sending chunks", chunksToSend.length);
      const promises: Promise<unknown>[] = [];
      promises.push(
        ctx.publisher.publish(`${ctx.keyPrefix}:chunk:${parsedMessage.listenerId}`, chunksToSend)
      );
      if (isDone) {
        promises.push(
          ctx.publisher.publish(`${ctx.keyPrefix}:chunk:${parsedMessage.listenerId}`, DONE_MESSAGE)
        );
      }
      await Promise.all(promises);
    }
  );

  return new ReadableStream<string>({
    start(controller) {
      const stream = makeStream();
      const reader = stream.getReader();
      function read() {
        reader
          .read()
          .then(async ({ done, value }) => {
            if (done) {
              debugLog("Stream done");
              try {
                controller.close();
              } catch (e) {
                //console.error(e);
              }
              await performCleanup();
              return;
            }
            if (joinedCache.length <= ctx.maxResumableSize) {
              joinedCache += value;
            }
            try {
              debugLog("Enqueuing line", value);
              controller.enqueue(value);
            } catch (e) {
              // If we cannot enqueue, the stream is already closed, but we WANT to continue.
            }
            const promises: Promise<unknown>[] = [];
            for (const listenerId of listenerChannels) {
              debugLog("sending line to", listenerId);
              promises.push(
                ctx.publisher.publish(`${ctx.keyPrefix}:chunk:${listenerId}`, value)
              );
            }
            await Promise.all(promises);
            read();
          })
          .catch(async () => {
            // Source stream error → close outer stream and clean up
            try {
              controller.close();
            } catch (e) {
              // stream may already be closed
            }
            await performCleanup();
          });
      }
      read();
    },
  });
}
/**
 * Creates a resumable stream of strings.
 *
 * @param streamId - The ID of the stream.
 * @param makeStream - A function that returns a stream of strings. It's only executed if the stream it not yet in progress.
 * @returns A stream of strings.
 */
async function createResumableStream(
  initPromise: Promise<unknown>,
  ctx: CreateResumableStreamContext,
  streamId: string,
  makeStream: () => ReadableStream<string>,
  skipCharacters?: number
): Promise<ReadableStream<string> | null> {
  await initPromise;

  const currentListenerCount = await incrOrDone(
    ctx.publisher,
    `${ctx.keyPrefix}:sentinel:${streamId}`
  );
  debugLog("currentListenerCount", currentListenerCount);
  if (currentListenerCount === DONE_VALUE) {
    return null;
  }
  if (currentListenerCount > 1) {
    return resumeStream(ctx, streamId, skipCharacters);
  }
  return createNewResumableStream(initPromise, ctx, streamId, makeStream);
}

export async function resumeStream(
  ctx: CreateResumableStreamContext,
  streamId: string,
  skipCharacters?: number
): Promise<ReadableStream<string> | null> {
  const listenerId = crypto.randomUUID();
  let cleanedUp = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    await ctx.subscriber.unsubscribe(`${ctx.keyPrefix}:chunk:${listenerId}`).catch(() => {});
  };

  return new Promise<ReadableStream<string> | null>((resolve, reject) => {
    const readableStream = new ReadableStream<string>({
      async start(controller) {
        try {
          debugLog("STARTING STREAM", streamId, listenerId);
          timeoutId = setTimeout(async () => {
            await cleanup();
            const val = await ctx.publisher.get(`${ctx.keyPrefix}:sentinel:${streamId}`);
            if (val === DONE_VALUE) {
              resolve(null);
              return;
            }
            try {
              controller.error(new Error("Timeout waiting for ack"));
            } catch (e) {
              // controller may already be closed
            }
            resolve(null);
          }, 1000);
          await ctx.subscriber.subscribe(
            `${ctx.keyPrefix}:chunk:${listenerId}`,
            async (message: string) => {
              debugLog("Received message", message);
              // The other side always sends a message even if it is the empty string.
              if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
              }
              resolve(readableStream);
              if (message === DONE_MESSAGE) {
                try {
                  controller.close();
                } catch (e) {
                  // errors can e.g. happen if the stream is already closed
                  // because the client has disconnected
                  // ignore them unless we are in debug mode
                  if (isDebug()) {
                    console.error(e);
                  }
                }
                await cleanup();
                return;
              }
              try {
                controller.enqueue(message);
              } catch (e) {
                // errors can e.g. happen if the stream is already closed
                // because the client has disconnected
                // ignore them unless we are in debug mode
                if (isDebug()) {
                  console.error(e);
                }
                await cleanup();
              }
            }
          );
          await ctx.publisher.publish(
            `${ctx.keyPrefix}:request:${streamId}`,
            JSON.stringify({
              listenerId,
              skipCharacters,
            })
          );
        } catch (e) {
          reject(e);
        }
      },
      cancel() {
        return cleanup();
      },
    });
  });
}

function incrOrDone(publisher: Publisher, key: string): Promise<typeof DONE_VALUE | number> {
  return publisher.incr(key).catch((reason) => {
    const errorString = String(reason);
    if (errorString.includes("ERR value is not an integer or out of range")) {
      return DONE_VALUE;
    }
    throw reason;
  });
}

function isDebug() {
  return process.env.DEBUG;
}

function debugLog(...messages: unknown[]) {
  if (isDebug()) {
    console.log(...messages);
  }
}
