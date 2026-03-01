import { describe, it, expect, vi, afterAll } from "vitest";
import Redis from "ioredis";
import { createTestingStream, streamToBuffer } from "../../testing-utils/testing-stream";
import { createResumableStreamContext } from "../ioredis";

function mb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

describe("memory leak with real ioredis", () => {
  // Track all Redis clients for cleanup
  const clients: Redis[] = [];

  afterAll(async () => {
    for (const client of clients) {
      try {
        client.disconnect();
      } catch {}
    }
  });

  it("TEST A: ioredis — chunks + external memory after stream completion", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000); // 1MB
    const STREAM_COUNT = 20;

    const pub = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    clients.push(pub, sub);

    const heldPromises = new Set<Promise<unknown>>();
    const prefix = "ioredis-leak-test-" + crypto.randomUUID();

    const resume = createResumableStreamContext({
      waitUntil: (p) => {
        heldPromises.add(p);
      },
      publisher: pub,
      subscriber: sub,
      keyPrefix: prefix,
    });

    // Baseline
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 100));
    const baseline = process.memoryUsage();

    // Create and complete N streams
    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(
        `stream-${i}`,
        () => readable
      );
      writer.write(LARGE_CHUNK);
      writer.close();
      await streamToBuffer(stream);
    }

    // Let promises settle
    await new Promise((r) => setTimeout(r, 500));

    // Verify all streams completed
    for (let i = 0; i < STREAM_COUNT; i++) {
      const state = await resume.hasExistingStream(`stream-${i}`);
      expect(state).toBe("DONE");
    }

    // GC
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 200));
    const after = process.memoryUsage();

    const retainedHeap = after.heapUsed - baseline.heapUsed;
    const retainedExternal = after.external - baseline.external;
    const retainedRss = after.rss - baseline.rss;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info("\n=== TEST A: IOREDIS — persistent promise refs ===");
    console.info(`Streams: ${STREAM_COUNT}, Total streamed: ${mb(total)} MB`);
    console.info(`Retained heap:     ${mb(retainedHeap)} MB`);
    console.info(`Retained external: ${mb(retainedExternal)} MB`);
    console.info(`Retained RSS:      ${mb(retainedRss)} MB`);
    console.info(`Baseline: heap=${mb(baseline.heapUsed)}, ext=${mb(baseline.external)}, rss=${mb(baseline.rss)}`);
    console.info(`After:    heap=${mb(after.heapUsed)}, ext=${mb(after.external)}, rss=${mb(after.rss)}`);
    console.info(`Held promises: ${heldPromises.size}`);
    console.info("=================================================\n");

    if (retainedExternal > total * 0.3) {
      console.info(">>> EXTERNAL MEMORY LEAK: ioredis Buffers retained after stream completion");
    }
    if (retainedHeap > total * 0.3) {
      console.info(">>> HEAP MEMORY LEAK: chunks[] retained after stream completion");
    }

    // Cleanup Redis keys
    const keys = await pub.keys(`${prefix}:*`);
    if (keys.length > 0) await pub.del(...keys);
  }, 60_000);

  it("TEST B: ioredis — linear growth measurement", async () => {
    const CHUNK = "y".repeat(500_000); // 500KB per stream

    const pub = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    clients.push(pub, sub);

    const heldPromises = new Set<Promise<unknown>>();
    const prefix = "ioredis-linear-test-" + crypto.randomUUID();

    const resume = createResumableStreamContext({
      waitUntil: (p) => {
        heldPromises.add(p);
      },
      publisher: pub,
      subscriber: sub,
      keyPrefix: prefix,
    });

    const measurements: {
      count: number;
      heapMB: number;
      extMB: number;
      rssMB: number;
    }[] = [];

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 100));

    for (let i = 0; i < 30; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(
        `stream-${i}`,
        () => readable
      );
      writer.write(CHUNK);
      writer.close();
      await streamToBuffer(stream);

      if ((i + 1) % 10 === 0) {
        await new Promise((r) => setTimeout(r, 200));
        if (global.gc) global.gc();
        await new Promise((r) => setTimeout(r, 100));
        const mem = process.memoryUsage();
        measurements.push({
          count: i + 1,
          heapMB: Math.round(mem.heapUsed / 1024 / 1024),
          extMB: Math.round(mem.external / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        });
      }
    }

    console.info("\n=== TEST B: IOREDIS — LINEAR GROWTH ===");
    for (const m of measurements) {
      console.info(
        `After ${m.count} streams: heap=${m.heapMB}MB, ext=${m.extMB}MB, rss=${m.rssMB}MB`
      );
    }
    const heapGrowth = measurements[2]!.heapMB - measurements[0]!.heapMB;
    const extGrowth = measurements[2]!.extMB - measurements[0]!.extMB;
    const expectedLeak = (20 * CHUNK.length) / 1024 / 1024;
    console.info(`Heap growth (10→30): ${heapGrowth}MB`);
    console.info(`External growth (10→30): ${extGrowth}MB`);
    console.info(`Expected if leaked: ~${expectedLeak.toFixed(0)}MB`);
    console.info("=======================================\n");

    // Cleanup Redis keys
    const keys = await pub.keys(`${prefix}:*`);
    if (keys.length > 0) await pub.del(...keys);
  }, 60_000);

  it("TEST C: ioredis — stream + reader + source held (full production sim)", async () => {
    const LARGE_CHUNK = "x".repeat(1_000_000);
    const STREAM_COUNT = 20;

    const pub = new Redis(REDIS_URL);
    const sub = new Redis(REDIS_URL);
    clients.push(pub, sub);

    const heldPromises = new Set<Promise<unknown>>();
    const heldStreams: ReadableStream<string>[] = [];
    const heldReaders: ReadableStreamDefaultReader<string>[] = [];
    const prefix = "ioredis-full-test-" + crypto.randomUUID();

    const resume = createResumableStreamContext({
      waitUntil: (p) => {
        heldPromises.add(p);
      },
      publisher: pub,
      subscriber: sub,
      keyPrefix: prefix,
    });

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 100));
    const baseline = process.memoryUsage();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const { readable, writer } = createTestingStream();
      const stream = await resume.createNewResumableStream(
        `stream-${i}`,
        () => readable
      );
      const reader = stream!.getReader();
      writer.write(LARGE_CHUNK);
      writer.close();

      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Hold everything alive — like Next.js does
      heldStreams.push(stream!);
      heldReaders.push(reader);
    }

    await new Promise((r) => setTimeout(r, 500));
    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 200));
    const after = process.memoryUsage();

    const retainedHeap = after.heapUsed - baseline.heapUsed;
    const retainedExternal = after.external - baseline.external;
    const total = STREAM_COUNT * LARGE_CHUNK.length;

    console.info("\n=== TEST C: IOREDIS — FULL PRODUCTION SIM ===");
    console.info(`Streams: ${STREAM_COUNT}, Total streamed: ${mb(total)} MB`);
    console.info(`Retained heap:     ${mb(retainedHeap)} MB`);
    console.info(`Retained external: ${mb(retainedExternal)} MB`);
    console.info(`Held: ${heldStreams.length} streams, ${heldReaders.length} readers, ${heldPromises.size} promises`);
    console.info(`Baseline: heap=${mb(baseline.heapUsed)}, ext=${mb(baseline.external)}`);
    console.info(`After:    heap=${mb(after.heapUsed)}, ext=${mb(after.external)}`);
    console.info("=============================================\n");

    if (retainedExternal > total * 0.3) {
      console.info(">>> EXTERNAL LEAK CONFIRMED with ioredis");
    }
    if (retainedHeap > total * 0.3) {
      console.info(">>> HEAP LEAK CONFIRMED with ioredis");
    }
    if (retainedExternal < total * 0.3 && retainedHeap < total * 0.3) {
      console.info(">>> No leak detected even with real ioredis");
    }

    // Cleanup Redis keys
    const keys = await pub.keys(`${prefix}:*`);
    if (keys.length > 0) await pub.del(...keys);
  }, 60_000);
});
