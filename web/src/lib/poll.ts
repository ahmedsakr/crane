/** Only the latest request may publish; cleanup invalidates pending requests. */
export function createPollRequest<T>(setData: (data: T) => void, setError: (error: string | null) => void) {
  let generation = 0;

  return {
    invalidate() {
      generation++;
    },
    async refresh(fetcher: () => Promise<T>) {
      const request = ++generation;
      try {
        const data = await fetcher();
        if (request !== generation) return;
        setData(data);
        setError(null);
      } catch (e) {
        if (request !== generation) return;
        setError((e as Error).message);
      }
    },
  };
}
