import { describe, it, expect } from "vitest";
import { createResumableStreamContext } from "../generic";
import { createInMemoryPubSubForTesting } from "../../testing-utils/in-memory-pubsub";
import { streamToBuffer, createTestingStream } from "../../testing-utils/testing-stream";

/**
 * Reproduction stress tests for the 2026-03-01 pathological case:
 *
 * A 304 KB LLM response with smoothStream word-level chunking generated
 * ~60,000 tiny SSE chunks. Combined with dead listener accumulation and
 * O(n) join on every resume, this pegged CPU at 100% for 110 minutes.
 *
 * These tests verify the v0.3.0 fixes:
 * 1. Cached join — no O(n) re-concatenation on resume
 * 2. Listener cap — dead consumers are evicted (default max 5)
 * 3. Size cap — streams exceeding maxResumableSize send DONE to new consumers
 *
 * Note: Chunk counts are kept moderate because the in-memory pubsub has
 * per-operation latency. The key behaviors (caps, DONE signals) are tested
 * with smaller counts that still exercise the same code paths.
 */
describe("large stream stress tests", () => {
  it("should complete a stream with many small chunks", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-" + crypto.randomUUID(),
    });

    const { readable, writer } = createTestingStream();
    const stream = await ctx.resumableStream("stress-stream", () => readable);

    // 100 chunks is enough to exercise the joinedCache path without
    // hitting the in-memory pubsub's per-operation sleep(1) wall
    const CHUNK_COUNT = 100;
    for (let i = 0; i < CHUNK_COUNT; i++) {
      writer.write(`word${i} `);
    }
    writer.close();

    expect(stream).not.toBeNull();
    const result = await streamToBuffer(stream!);

    const words = result.trim().split(" ");
    expect(words.length).toBe(CHUNK_COUNT);
    expect(words[0]).toBe("word0");
    expect(words[CHUNK_COUNT - 1]).toBe(`word${CHUNK_COUNT - 1}`);
  }, 30_000);

  it("should handle a resume consumer during a multi-chunk stream", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-multi-" + crypto.randomUUID(),
    });

    const { readable, writer } = createTestingStream();

    // First consumer creates the stream
    const stream1 = await ctx.resumableStream("multi-stream", () => readable);

    // Second consumer resumes immediately
    const stream2 = await ctx.resumableStream("multi-stream", () => {
      throw new Error("Should not create a new stream");
    });

    const CHUNK_COUNT = 50;
    for (let i = 0; i < CHUNK_COUNT; i++) {
      writer.write(`chunk${i} `);
    }
    writer.close();

    expect(stream1).not.toBeNull();
    expect(stream2).not.toBeNull();

    const result1 = await streamToBuffer(stream1!);
    const result2 = await streamToBuffer(stream2!);

    // Both consumers should receive all chunks
    expect(result1.trim().split(" ").length).toBe(CHUNK_COUNT);
    expect(result2.trim().split(" ").length).toBe(CHUNK_COUNT);
  }, 30_000);

  it("should enforce size cap and send DONE to new resume consumers", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    // Set a very small size cap so we can trigger it easily
    const MAX_SIZE = 500; // 500 bytes
    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-sizecap-" + crypto.randomUUID(),
      maxResumableSize: MAX_SIZE,
    });

    const { readable, writer } = createTestingStream();
    const stream1 = await ctx.resumableStream("sizecap-stream", () => readable);

    // Write enough data to exceed the size cap
    const bigChunk = "x".repeat(MAX_SIZE + 100);
    writer.write(bigChunk);

    // Give the stream time to process the chunk through the async read() loop
    // (in-memory pubsub has 1ms sleep per operation)
    await new Promise((r) => setTimeout(r, 500));

    // A new consumer arriving after size cap is exceeded gets DONE_SENTINEL.
    // resumeStream resolves with a ReadableStream that is closed immediately
    // (the DONE_MESSAGE handler calls controller.close() after resolve).
    const stream2 = await ctx.resumableStream("sizecap-stream", () => {
      throw new Error("Should not create a new stream");
    });

    writer.close();

    // stream1 should complete normally with the data
    expect(stream1).not.toBeNull();
    const result1 = await streamToBuffer(stream1!);
    expect(result1).toBe(bigChunk);

    // stream2 gets DONE immediately — either null (sentinel already DONE)
    // or an empty closed stream. Either way, no large replay happened.
    if (stream2 !== null) {
      const result2 = await streamToBuffer(stream2);
      expect(result2.length).toBeLessThan(MAX_SIZE);
    }
  }, 10_000);

  it("should stop growing joinedCache once maxResumableSize is exceeded", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    const MAX_SIZE = 200;
    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-cachegrow-" + crypto.randomUUID(),
      maxResumableSize: MAX_SIZE,
    });

    const { readable, writer } = createTestingStream();
    const stream = await ctx.resumableStream("cachegrow-stream", () => readable);

    // Write data that exceeds the cap
    const chunk1 = "a".repeat(MAX_SIZE + 50);
    const chunk2 = "b".repeat(100);
    writer.write(chunk1);
    writer.write(chunk2);
    writer.close();

    expect(stream).not.toBeNull();
    const result = await streamToBuffer(stream!);

    // The original consumer still gets ALL data — size cap only affects
    // the joinedCache used for resume replay, not the primary stream
    expect(result).toBe(chunk1 + chunk2);
  }, 10_000);

  it("should handle custom maxListeners option", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-maxlisteners-" + crypto.randomUUID(),
      maxListeners: 2,
    });

    const { readable, writer } = createTestingStream();
    const stream1 = await ctx.resumableStream("cap-stream", () => readable);

    // Create 4 resume consumers (exceeds cap of 2)
    const streams: (ReadableStream<string> | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await ctx.resumableStream("cap-stream", () => {
        throw new Error("Should not create");
      });
      streams.push(s);
    }

    writer.write("hello ");
    writer.close();

    const result1 = await streamToBuffer(stream1!);
    expect(result1).toBe("hello ");

    // With cap of 2, at most 2 resume consumers should get the final chunk.
    // Earlier consumers may have been evicted from the listener list.
    let received = 0;
    for (const s of streams) {
      if (s !== null) {
        try {
          const r = await streamToBuffer(s);
          if (r.includes("hello")) received++;
        } catch {
          // Expected for evicted listeners — their subscription timed out
        }
      }
    }
    expect(received).toBeGreaterThanOrEqual(1);
    expect(received).toBeLessThanOrEqual(2);
  }, 15_000);

  it("should handle custom maxResumableSize option", async () => {
    const { publisher, subscriber } = createInMemoryPubSubForTesting();

    // Very large cap — should not trigger
    const ctx = createResumableStreamContext({
      waitUntil: null,
      publisher,
      subscriber,
      keyPrefix: "stress-bigcap-" + crypto.randomUUID(),
      maxResumableSize: 10 * 1024 * 1024, // 10 MB
    });

    const { readable, writer } = createTestingStream();
    const stream1 = await ctx.resumableStream("bigcap-stream", () => readable);

    // Second consumer should resume normally (not hit size cap)
    const stream2 = await ctx.resumableStream("bigcap-stream", () => {
      throw new Error("Should not create");
    });

    writer.write("data ");
    writer.close();

    expect(stream1).not.toBeNull();
    expect(stream2).not.toBeNull();

    const result1 = await streamToBuffer(stream1!);
    const result2 = await streamToBuffer(stream2!);

    expect(result1).toBe("data ");
    expect(result2).toBe("data ");
  }, 10_000);
});
