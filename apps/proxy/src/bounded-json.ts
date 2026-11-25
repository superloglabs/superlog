// JSON ingest bodies are parsed into objects before they are rewritten or
// mapped to rows. A small body of many tiny objects or arrays parses into far
// more memory than its size, so decoding stops at these limits. The limits are
// well above what OTLP exporters and log drains send in one request.
export const MAX_DECODED_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_CONTAINERS = 250_000;

export class DecodeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeLimitError";
  }
}

export function assertDecodableSize(body: Buffer, maxBytes = MAX_DECODED_BODY_BYTES): void {
  if (body.length > maxBytes) {
    throw new DecodeLimitError(`body exceeds the ${maxBytes}-byte decode limit`);
  }
}

// Counts the text's objects and arrays. Brackets inside strings count too,
// which only makes the limit stricter.
export function assertJsonContainers(text: string, maxContainers = MAX_JSON_CONTAINERS): void {
  let containers = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x7b || code === 0x5b) {
      containers += 1;
      if (containers > maxContainers) {
        throw new DecodeLimitError(`JSON body has more than ${maxContainers} objects and arrays`);
      }
    }
  }
}

export function parseBoundedJson(
  text: string,
  maxContainers = MAX_JSON_CONTAINERS,
): ReturnType<typeof JSON.parse> {
  assertJsonContainers(text, maxContainers);
  return JSON.parse(text);
}
