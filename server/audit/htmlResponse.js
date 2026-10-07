export const MAX_HTML_BYTES = 1024 * 1024;

/**
 * Read a response body up to `maxBytes` and decode it as text. Large pages are
 * truncated rather than buffered whole: the first MiB still carries the head
 * metadata and navigation the audit needs.
 */
export async function readTextUpTo(response, maxBytes) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (bytesRead >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  parts.push(decoder.decode());
  return parts.join("");
}
