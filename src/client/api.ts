/** Every command reports its outcome; callers must not treat a caught error as success. */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The action could not be completed.';
}

export async function requestJson<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { signal }
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Stockbridge-Request': '1',
          },
          body: JSON.stringify(body),
          signal,
        },
  );

  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'error' in result
        ? String(result.error)
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return result as T;
}
