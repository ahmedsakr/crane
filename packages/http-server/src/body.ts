/** Empty bodies use action defaults; malformed or non-object JSON must never trigger a decision. */
export async function optionalJsonObject<T extends object>(request: Request): Promise<T> {
  const text = await request.text();
  const body: unknown = text === "" ? {} : JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as T;
}
