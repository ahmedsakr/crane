/** A refusal about who is asking, which the API answers with `status` rather than 400. */
export class AccessError extends Error {
  constructor(readonly status: 401 | 403 | 429, message: string) {
    super(message);
    this.name = "AccessError";
  }
}
