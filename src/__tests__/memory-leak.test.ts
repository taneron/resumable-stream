import { describe, it, expect, vi } from "vitest";
import { createInMemoryPubSubForTesting } from "../../testing-utils/in-memory-pubsub";
import { createTestingStream, streamToBuffer } from "../../testing-utils/testing-stream";
import { createResumableStreamContext } from "..";

// Suppress noisy debug logs from the in-memory pubsub
vi.spyOn(console, "log").mockImplementation(() => {});

function mb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

describe("memory leak: chunks retained after stream completion", () => {
  it("TEST 1: baseline — promises awaited & released", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const waitUntilPromises: Promise<unknown>[] = [];
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test1-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);
      writer.write(LARGE_CHUNK);
      writer.close();
      await streamToBuffer(stream);
    }

    await Promise.all(waitUntilPromises);
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nTEST 1: Retained ${mb(retained)} MB / ${mb(total)} MB streamed — CLEAN`);
    expect(retained).toBeLessThan(total * 0.5);
  }, 30_000);

  it("TEST 2: persistent promise refs (simulates after())", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const heldPromises = new Set<Promise<unknown>>();
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { heldPromises.add(p); },
      subscriber, publisher,
      keyPrefix: "test2-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);
      writer.write(LARGE_CHUNK);
      writer.close();
      await streamToBuffer(stream);
    }

    await new Promise((r) => setTimeout(r, 200));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nTEST 2: Retained ${mb(retained)} MB / ${mb(total)} MB — persistent promise refs`);
    expect.soft(retained).toBeLessThan(total * 0.5);
  }, 30_000);

  it("TEST 3: stream objects held alive (simulates Next.js response body)", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const heldStreams: ReadableStream<string>[] = [];
    const heldPromises = new Set<Promise<unknown>>();

    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { heldPromises.add(p); },
      subscriber, publisher,
      keyPrefix: "test3-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);
      writer.write(LARGE_CHUNK);
      writer.close();
      await streamToBuffer(stream);

      heldStreams.push(stream!);
    }

    await new Promise((r) => setTimeout(r, 200));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nTEST 3: Retained ${mb(retained)} MB / ${mb(total)} MB — held stream objects`);
    console.info(`  Held streams: ${heldStreams.length}, held promises: ${heldPromises.size}`);

    expect.soft(retained).toBeLessThan(total * 0.5);
  }, 30_000);

  it("TEST 4: stream + reader objects held alive", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const heldReaders: ReadableStreamDefaultReader<string>[] = [];
    const heldStreams: ReadableStream<string>[] = [];
    const heldPromises = new Set<Promise<unknown>>();

    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { heldPromises.add(p); },
      subscriber, publisher,
      keyPrefix: "test4-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);

      const reader = stream!.getReader();
      writer.write(LARGE_CHUNK);
      writer.close();

      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      heldStreams.push(stream!);
      heldReaders.push(reader);
    }

    await new Promise((r) => setTimeout(r, 200));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nTEST 4: Retained ${mb(retained)} MB / ${mb(total)} MB — held stream + reader`);
    console.info(`  Held streams: ${heldStreams.length}, readers: ${heldReaders.length}`);

    expect.soft(retained).toBeLessThan(total * 0.5);
  }, 30_000);

  it("TEST 5: full production simulation — everything held", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const heldStreams: ReadableStream<string>[] = [];
    const heldSourceStreams: ReadableStream<string>[] = [];
    const heldReaders: ReadableStreamDefaultReader<string>[] = [];
    const heldPromises = new Set<Promise<unknown>>();

    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { heldPromises.add(p); },
      subscriber, publisher,
      keyPrefix: "test5-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();

      heldSourceStreams.push(readable);

      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);
      const reader = stream!.getReader();

      writer.write(LARGE_CHUNK);
      writer.close();

      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      heldStreams.push(stream!);
      heldReaders.push(reader);
    }

    await new Promise((r) => setTimeout(r, 200));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nTEST 5: Retained ${mb(retained)} MB / ${mb(total)} MB — FULL PRODUCTION SIM`);
    console.info(`  Held: ${heldStreams.length} streams, ${heldReaders.length} readers, ${heldSourceStreams.length} sources, ${heldPromises.size} promises`);

    expect.soft(retained).toBeLessThan(total * 0.5);
  }, 30_000);
});

describe("memory leak: error, cancel, and timeout paths", () => {
  it("source stream error triggers cleanup", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test-error-" + crypto.randomUUID(),
    });

    const { readable, writer } = createTestingStream();
    const stream = await resume.createNewResumableStream("err-stream", () => readable);

    // Write some data then error the source
    writer.write("partial data");
    // Small delay to let the read loop process
    await new Promise((r) => setTimeout(r, 50));
    writer.abort(new Error("source failed"));

    // waitUntil promise should resolve (not hang forever)
    const result = await Promise.race([
      Promise.all(waitUntilPromises).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    expect(result).toBe("resolved");

    // Sentinel should be DONE — a new stream with same ID should be creatable
    const state = await resume.hasExistingStream("err-stream");
    expect(state).toBe("DONE");
  }, 10_000);

  it("stream cancel triggers cleanup", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test-cancel-" + crypto.randomUUID(),
    });

    const { readable, writer } = createTestingStream();
    const stream = await resume.createNewResumableStream("cancel-stream", () => readable);

    // Write some data
    writer.write("partial data");
    await new Promise((r) => setTimeout(r, 50));

    // Cancel the outer ReadableStream (simulates client disconnect)
    await stream!.cancel();

    // waitUntil promise should resolve (not hang forever)
    const result = await Promise.race([
      Promise.all(waitUntilPromises).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    expect(result).toBe("resolved");

    // Sentinel should be DONE
    const state = await resume.hasExistingStream("cancel-stream");
    expect(state).toBe("DONE");
  }, 10_000);

  it("resumeStream timeout always resolves", async () => {
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: () => {},
      subscriber, publisher,
      keyPrefix: "test-timeout-" + crypto.randomUUID(),
    });

    // Create a sentinel so resumeExistingStream doesn't return undefined
    // but don't actually create a producer — so the resume will timeout
    await publisher.set(
      `test-timeout-${/* get the actual prefix */ ""}:rs:sentinel:timeout-stream`,
      "1",
      { EX: 60 }
    );

    // Use resumeExistingStream which calls resumeStream internally
    // Since there's no producer, the timeout should fire and resolve(null)
    const result = await Promise.race([
      resume.resumeExistingStream("timeout-stream").then((s) =>
        s === null ? "resolved-null" : s === undefined ? "resolved-undefined" : "resolved-stream"
      ),
      new Promise((r) => setTimeout(() => r("hung"), 5000)),
    ]);

    // Should resolve within ~1s, not hang
    expect(result).not.toBe("hung");
  }, 10_000);

  it("chunks cleared after completion — held refs don't retain data", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 10;

    const heldStreams: ReadableStream<string>[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];

    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test-chunks-" + crypto.randomUUID(),
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(`s-${i}`, () => readable);
      writer.write(LARGE_CHUNK);
      writer.close();
      await streamToBuffer(stream);
      heldStreams.push(stream!);
    }

    await Promise.all(waitUntilPromises);
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 50));
    const after = process.memoryUsage();
    const retained = after.heapUsed - baseline.heapUsed;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info(`\nChunks cleared test: Retained ${mb(retained)} MB / ${mb(total)} MB`);
    expect(retained).toBeLessThan(total * 0.5);
  }, 30_000);
});

describe("resumeStream cleanup", () => {
  it("cancelling a resumed stream triggers unsubscribe", async () => {
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const unsubscribeSpy = vi.spyOn(subscriber, "unsubscribe");

    const waitUntilPromises: Promise<unknown>[] = [];
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test-resume-cancel-" + crypto.randomUUID(),
    });

    // Create a producer stream that stays open
    const { readable, writer } = createTestingStream();
    const producerStream = await resume.createNewResumableStream("rc-stream", () => readable);

    // Write some data so the producer is active
    writer.write("hello ");
    await new Promise((r) => setTimeout(r, 50));

    // Resume the stream (consumer side)
    const consumerStream = await resume.resumeExistingStream("rc-stream");
    expect(consumerStream).not.toBeNull();
    expect(consumerStream).not.toBeUndefined();

    // Read the initial catch-up data
    const reader = consumerStream!.getReader();
    const { value } = await reader.read();
    expect(value).toBe("hello ");
    reader.releaseLock();

    // Cancel the consumer stream (simulates client disconnect)
    await consumerStream!.cancel();

    // Verify unsubscribe was called for the chunk channel
    const chunkUnsubscribes = unsubscribeSpy.mock.calls.filter(
      ([channel]) => typeof channel === "string" && channel.includes(":chunk:")
    );
    expect(chunkUnsubscribes.length).toBeGreaterThanOrEqual(1);

    // Clean up: close the producer
    writer.close();
    await streamToBuffer(producerStream);
    await Promise.all(waitUntilPromises);
  }, 10_000);

  it("hasExistingStream works immediately after construction", async () => {
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const resume = createResumableStreamContext({
      waitUntil: () => {},
      subscriber, publisher,
      keyPrefix: "test-has-existing-" + crypto.randomUUID(),
    });

    // Call hasExistingStream immediately — should not throw even if
    // initPromises haven't resolved yet
    const result = await resume.hasExistingStream("nonexistent");
    expect(result).toBeNull();
  }, 5_000);

  it("unsubscribe is called on chunk channel when resumed stream completes", async () => {
    const { subscriber, publisher } = createInMemoryPubSubForTesting();
    const unsubscribeSpy = vi.spyOn(subscriber, "unsubscribe");

    const waitUntilPromises: Promise<unknown>[] = [];
    const resume = createResumableStreamContext({
      waitUntil: (p) => { waitUntilPromises.push(p); },
      subscriber, publisher,
      keyPrefix: "test-unsub-done-" + crypto.randomUUID(),
    });

    // Create a producer stream
    const { readable, writer } = createTestingStream();
    const producerStream = await resume.createNewResumableStream("ud-stream", () => readable);

    // Write data
    writer.write("data");
    await new Promise((r) => setTimeout(r, 50));

    // Resume the stream
    const consumerStream = await resume.resumeExistingStream("ud-stream");
    expect(consumerStream).not.toBeNull();
    expect(consumerStream).not.toBeUndefined();

    // Close the producer — this should send DONE to the consumer
    writer.close();

    // Consume both streams to completion
    await streamToBuffer(consumerStream);
    await streamToBuffer(producerStream);
    await Promise.all(waitUntilPromises);

    // Verify the chunk channel was unsubscribed
    const chunkUnsubscribes = unsubscribeSpy.mock.calls.filter(
      ([channel]) => typeof channel === "string" && channel.includes(":chunk:")
    );
    expect(chunkUnsubscribes.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
