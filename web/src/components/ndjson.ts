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
 * Bad lines throw a parse error. Callers should wrap in try/catch or
 * handle it at the for-await level.
 */
export async function* readNdjson<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        const trailing = buf.trim();
        if (trailing) yield JSON.parse(trailing) as T;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* */ }
  }
}
