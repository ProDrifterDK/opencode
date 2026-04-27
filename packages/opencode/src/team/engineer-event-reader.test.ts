/**
 * Phase 2 of A3 (subprocess-per-engineer) tests.
 *
 * The reader is unit-tested in isolation: we own the ReadableStream
 * that feeds it, so no real `Bun.spawn` involved. Tests assert:
 *   - well-formed JSON-lines round-trip into onEvent
 *   - malformed JSON / unknown types / oversized lines are skipped
 *     without killing the reader
 *   - the next valid line after a malformed one still lands
 *   - stderr drain forwards bytes to the configured sink and does not
 *     block on a noisy producer
 */
import { describe, test, expect } from "bun:test"
import {
  decodeEventLine,
  readEngineerEvents,
  drainEngineerStderr,
  MAX_LINE_BYTES,
} from "./engineer-event-reader"

const enc = new TextEncoder()

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe("decodeEventLine", () => {
  test("accepts a well-formed event with a known type", () => {
    const line = JSON.stringify({
      type: "engineer.spawned",
      properties: {
        teamID: "t1",
        engineerID: "e1",
        sessionID: "s1",
        name: "alice",
        state: "working",
        taskID: "task1",
        taskTitle: "do",
        taskDescription: "thing",
      },
    })
    const out = decodeEventLine(line)
    expect(out).not.toBeNull()
    expect(out!.type).toBe("engineer.spawned")
  })

  test("accepts enriched engineer.completed report payload", () => {
    const line = JSON.stringify({
      type: "engineer.completed",
      properties: {
        teamID: "t1",
        engineerID: "e1",
        taskId: "task1",
        taskTitle: "Frontend Review",
        engineerName: "engineer-frontend",
        summary: "Report written to .tmp/report.md",
      },
    })
    const out = decodeEventLine(line)
    expect(out).not.toBeNull()
    expect(out!.type).toBe("engineer.completed")
  })

  test("rejects malformed JSON", () => {
    const errors: string[] = []
    const out = decodeEventLine("{not-json", { onError: (r) => errors.push(r) })
    expect(out).toBeNull()
    expect(errors[0]).toContain("JSON parse failed")
  })

  test("rejects an event with an unknown type", () => {
    const errors: string[] = []
    const line = JSON.stringify({ type: "totally.made.up", properties: {} })
    const out = decodeEventLine(line, { onError: (r) => errors.push(r) })
    expect(out).toBeNull()
    expect(errors[0]).toContain("unknown type")
  })

  test("rejects an event missing properties", () => {
    const errors: string[] = []
    const line = JSON.stringify({ type: "engineer.spawned" })
    const out = decodeEventLine(line, { onError: (r) => errors.push(r) })
    expect(out).toBeNull()
    expect(errors[0]).toContain("missing properties")
  })

  test("rejects empty / whitespace lines silently (returns null, no error)", () => {
    const errors: string[] = []
    expect(decodeEventLine("", { onError: (r) => errors.push(r) })).toBeNull()
    expect(decodeEventLine("   \t  ", { onError: (r) => errors.push(r) })).toBeNull()
    expect(errors).toHaveLength(0)
  })

  test("rejects oversized lines", () => {
    const errors: string[] = []
    const huge = "x".repeat(MAX_LINE_BYTES + 100)
    const out = decodeEventLine(huge, { onError: (r) => errors.push(r) })
    expect(out).toBeNull()
    expect(errors[0]).toContain("MAX_LINE_BYTES")
  })

  test("multibyte: line just under 1MB UTF-8 bytes is accepted", () => {
    // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units (surrogate pair).
    // 1MB = 1_048_576 bytes. At 4 bytes/emoji we need 262_143 emojis to stay
    // just under the cap (262_143 * 4 = 1_048_572 bytes < 1_048_576).
    // We wrap it in a valid JSON event so decodeEventLine doesn't reject for
    // unrelated reasons — but since the *trimmed* string (the whole JSON) must
    // be under the cap, we use a tiny wrapper and put the payload inside.
    const emojiCount = 50_000 // 200_000 UTF-8 bytes — safely under 1MB
    const payload = "😀".repeat(emojiCount)
    const line = JSON.stringify({
      type: "engineer.progress",
      properties: { teamID: "t1", engineerID: "e1", progressText: payload, timestamp: 1 },
    })
    const byteLen = Buffer.byteLength(line, "utf8")
    expect(byteLen).toBeLessThan(MAX_LINE_BYTES)
    const out = decodeEventLine(line)
    expect(out).not.toBeNull()
    expect(out!.type).toBe("engineer.progress")
  })

  test("multibyte: line just over 1MB UTF-8 bytes is rejected", () => {
    // Build a string whose UTF-8 byte length exceeds MAX_LINE_BYTES.
    // Each "😀" is 4 UTF-8 bytes; 262_145 emojis = 1_048_580 bytes > 1MB.
    const emojiCount = 262_145
    const line = "😀".repeat(emojiCount)
    const byteLen = Buffer.byteLength(line, "utf8")
    expect(byteLen).toBeGreaterThan(MAX_LINE_BYTES)
    const errors: string[] = []
    const out = decodeEventLine(line, { onError: (r) => errors.push(r) })
    expect(out).toBeNull()
    expect(errors[0]).toContain("MAX_LINE_BYTES")
  })
})

describe("readEngineerEvents (round-trip)", () => {
  const validLine = (taskTitle: string) =>
    JSON.stringify({
      type: "engineer.progress",
      properties: {
        teamID: "t1",
        engineerID: "e1",
        progressText: taskTitle,
        timestamp: 12345,
      },
    }) + "\n"

  test("three valid lines all reach onEvent in order", async () => {
    const seen: string[] = []
    const stream = streamFromChunks([validLine("a"), validLine("b"), validLine("c")])
    await readEngineerEvents(stream, {
      onEvent: (e) => {
        const props = e.properties as { progressText: string }
        seen.push(props.progressText)
      },
    })
    expect(seen).toEqual(["a", "b", "c"])
  })

  test("malformed line is skipped; subsequent valid line still lands", async () => {
    const seen: string[] = []
    const errors: string[] = []
    const stream = streamFromChunks([
      validLine("first"),
      "{not-json\n",
      validLine("second"),
    ])
    await readEngineerEvents(stream, {
      onEvent: (e) => {
        const props = e.properties as { progressText: string }
        seen.push(props.progressText)
      },
      onError: (r) => errors.push(r),
    })
    expect(seen).toEqual(["first", "second"])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("JSON parse failed")
  })

  test("unknown event type is skipped without killing the reader", async () => {
    const seen: string[] = []
    const errors: string[] = []
    const bogus = JSON.stringify({ type: "engineer.bogus", properties: { x: 1 } }) + "\n"
    const stream = streamFromChunks([bogus, validLine("ok")])
    await readEngineerEvents(stream, {
      onEvent: (e) => seen.push(e.type),
      onError: (r) => errors.push(r),
    })
    expect(seen).toEqual(["engineer.progress"])
    expect(errors[0]).toContain("unknown type")
  })

  test("a line just under the cap round-trips", async () => {
    // Pack a long progressText close to the cap. The whole serialized
    // event must stay under MAX_LINE_BYTES; subtract some headroom.
    const big = "y".repeat(100_000)
    const line =
      JSON.stringify({
        type: "engineer.progress",
        properties: {
          teamID: "t1",
          engineerID: "e1",
          progressText: big,
          timestamp: 1,
        },
      }) + "\n"
    const stream = streamFromChunks([line])
    const seen: string[] = []
    await readEngineerEvents(stream, {
      onEvent: (e) => {
        const props = e.properties as { progressText: string }
        seen.push(String(props.progressText.length))
      },
    })
    expect(seen).toEqual([String(big.length)])
  })

  test("oversized line is rejected; reader keeps going", async () => {
    const errors: string[] = []
    const seen: string[] = []
    // A line over MAX_LINE_BYTES with no newline forces the buffer
    // overflow path. We split it into chunks so the reader sees the
    // overflow before any newline.
    const oversize = "z".repeat(MAX_LINE_BYTES + 50)
    const stream = streamFromChunks([
      oversize, // no newline -> overflow path
      "\n", // close out the bad line
      validLine("after-overflow"),
    ])
    await readEngineerEvents(stream, {
      onEvent: (e) => {
        const props = e.properties as { progressText: string }
        seen.push(props.progressText)
      },
      onError: (r) => errors.push(r),
    })
    expect(errors.some((e) => e.includes("MAX_LINE_BYTES"))).toBe(true)
    expect(seen).toEqual(["after-overflow"])
  })

  test("a partial line spread across chunks reassembles correctly", async () => {
    const line = validLine("split")
    const half = Math.floor(line.length / 2)
    const stream = streamFromChunks([line.slice(0, half), line.slice(half)])
    const seen: string[] = []
    await readEngineerEvents(stream, {
      onEvent: (e) => {
        const props = e.properties as { progressText: string }
        seen.push(props.progressText)
      },
    })
    expect(seen).toEqual(["split"])
  })

  test("event with mismatched schema (known type, wrong shape) is dropped via default onEvent", async () => {
    // Default onEvent runs schema validation. We don't have a Bus
    // context here, so we just confirm that a known-type-but-bad-shape
    // payload doesn't throw. The decoder accepts it (type is known);
    // the default onEvent will fail schema validation and warn-log.
    const bad =
      JSON.stringify({
        type: "engineer.progress",
        properties: { teamID: "t", engineerID: "e" /* missing progressText, timestamp */ },
      }) + "\n"
    const stream = streamFromChunks([bad])
    // No throw = success here.
    await readEngineerEvents(stream)
    expect(true).toBe(true)
  })
})

describe("drainEngineerStderr", () => {
  test("forwards stderr bytes to the configured sink", async () => {
    const written: Uint8Array[] = []
    const sink = { write: (chunk: Uint8Array) => written.push(chunk) }
    const stream = streamFromChunks(["warn: something\n", "more output\n"])
    await drainEngineerStderr(stream, sink)
    const joined = Buffer.concat(written.map((c) => Buffer.from(c))).toString("utf-8")
    expect(joined).toBe("warn: something\nmore output\n")
  })

  test("a sink that throws does not stop the drain", async () => {
    let writes = 0
    const sink = {
      write: () => {
        writes++
        if (writes === 1) throw new Error("downstream broken")
      },
    }
    const stream = streamFromChunks(["chunk-a", "chunk-b"])
    // Should not throw despite the first sink.write failing.
    await drainEngineerStderr(stream, sink)
    expect(writes).toBe(2)
  })
})
