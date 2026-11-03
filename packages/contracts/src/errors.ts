/** Present thrown values consistently, including values that are not Errors. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
