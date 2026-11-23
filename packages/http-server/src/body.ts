/** Empty bodies use action defaults; malformed or non-object JSON must never trigger a decision. */
export async function optionalJsonObject<T extends object>(request: Request): Promise<T> {
  return parseJsonObject<T>(await request.text());
}

export function parseJsonObject<T extends object>(text: string): T {
  let body: unknown;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new Error("Expected a JSON object");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as T;
}

export class BodyTooLarge extends Error {
  constructor() {
    super("Request body is too large");
  }
}

/** Cap the declared size and count actual bytes before passing each chunk to a body parser. */
export function boundedBody(request: Request, maxBytes: number): Response {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLarge();
  let bytes = 0;
  const stream = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new BodyTooLarge();
      controller.enqueue(chunk);
    },
  }));
  const contentType = request.headers.get("content-type");
  return new Response(stream, { headers: contentType ? { "content-type": contentType } : undefined });
}

export async function boundedJsonObject<T extends object>(request: Request, maxBytes: number): Promise<T> {
  return parseJsonObject<T>(await boundedBody(request, maxBytes).text());
}
