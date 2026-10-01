/**
 * Rust-style `Result`. Expected failures (upstream errors, invalid input, conflicts)
 * are values; only genuinely unexpected failures (e.g. a broken SQLite file) throw.
 */
export type Result<T, E> = Ok<T> | Err<E>;
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export async function fromPromise<T, E>(
  promise: Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(mapError(cause));
  }
}

export function fromThrowable<T, E>(fn: () => T, mapError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(mapError(cause));
  }
}

/** Like `Iterator<Result<T, E>>::collect::<Result<Vec<T>, E>>()`: the first error wins. */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Re-runs `attempt` after each delay for as long as it fails with a retryable error. */
export async function retry<T, E>(
  attempt: () => Promise<Result<T, E>>,
  isRetryable: (error: E) => boolean,
  delaysMs: readonly number[] = [2_000, 15_000, 60_000],
): Promise<Result<T, E>> {
  let result = await attempt();
  for (const delay of delaysMs) {
    if (result.ok || !isRetryable(result.error)) return result;
    await Bun.sleep(delay);
    result = await attempt();
  }
  return result;
}

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const parseJson = (text: string): Result<unknown, string> =>
  fromThrowable((): unknown => JSON.parse(text), errorMessage);
