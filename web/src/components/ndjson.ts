/**
 * Tiny NDJSON stream reader for the chat endpoint.
 *
 * Reads a ReadableStream<Uint8Array> (what you get from `fetch(...).body`),
 * splits on newlines, and yields each parsed JSON object as an async
 * generator value. Handles:
 *   - UTF-8 multi-byte sequences crossing chunk boundaries (TextDecoder
 *     stream: true)
 *   - Partial JSON lines at the end of a chunk (buffered)
 *   - Blank lines (skipped)
 *   - A trailing line without a newline (emitted on stream close)
 *
 * By default a bad line throws, and callers should handle it at the for-await
 * level. Pass `{ tolerant: true }` to yield a `{type:"warning"}` object instead
 * and keep reading — see below for when that is the right choice.
 */
export interface NdjsonOptions {
  /**
   * Survive a malformed line instead of aborting the stream.
   *
   * Correct for a job event stream: if the server is killed mid-write the final
   * line can be truncated, and throwing there would discard an entire replayed
   * transcript over one damaged trailing byte. The events already delivered are
   * real and worth keeping.
   *
   * Wrong for a request/response body, where a malformed line means the whole
   * payload is untrustworthy.
   */
  tolerant?: boolean;
}

export async function* readNdjson<T>(
  stream: ReadableStream<Uint8Array>,
  opts: NdjsonOptions = {},
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  const parse = function* (line: string): Generator<T> {
    try {
      yield JSON.parse(line) as T;
    } catch (err) {
      if (!opts.tolerant) throw err;
      yield {
        type: "warning",
        warning: `discarded a malformed stream line (${(err as Error).message})`,
      } as unknown as T;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        const trailing = buf.trim();
        if (trailing) yield* parse(trailing);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield* parse(line);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* */ }
  }
}
