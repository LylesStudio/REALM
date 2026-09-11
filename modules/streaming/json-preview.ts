/**
 * M4 incremental readable-text extractor for streamed structured JSON.
 *
 * Model phases stream JSON objects (e.g. {"action":"…","dialogue":"…"}).
 * Raw JSON must never reach a preview card; this extractor turns the partial
 * stream into readable text deltas for the listed string fields, in order.
 * It is tolerant of arbitrary chunk splits and string escapes.
 */
export function createJsonFieldPreviewExtractor(
  fields: readonly string[],
): (chunk: string) => string | null {
  let buffer = "";
  let fieldIndex = 0;
  let valueStart = -1;
  let emitted = 0;

  function locateValueStart(): boolean {
    if (valueStart >= 0 || fieldIndex >= fields.length) return valueStart >= 0;
    const marker = `"${fields[fieldIndex]}":`;
    const markerAt = buffer.indexOf(marker);
    if (markerAt < 0) return false;
    const quoteAt = buffer.indexOf('"', markerAt + marker.length);
    if (quoteAt < 0) return false;
    valueStart = quoteAt + 1;
    emitted = 0;
    return true;
  }

  function valueEnd(): number {
    if (valueStart < 0) return -1;
    for (let index = valueStart; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') return index;
    }
    return -1;
  }

  return (chunk) => {
    buffer += chunk;
    if (!locateValueStart()) return null;
    const end = valueEnd();
    if (end >= 0) {
      // 字段闭合：先吐出闭合前的增量，再推进到下一个字段。
      const closing = buffer.slice(valueStart + emitted, end);
      fieldIndex += 1;
      valueStart = -1;
      emitted = 0;
      const readable = closing.replace(/\\(["\\/])/g, "$1");
      return readable || null;
    }
    const available = buffer.length - valueStart;
    if (available <= emitted) return null;
    const delta = buffer.slice(valueStart + emitted);
    emitted = available;
    const readable = delta.replace(/\\(["\\/])/g, "$1");
    return readable || null;
  };
}
