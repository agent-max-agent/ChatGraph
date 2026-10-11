import type { IndexProgress } from './types.js';

export async function scanRequest<T>(
  progress: IndexProgress,
  read: () => Promise<T>,
  save: () => Promise<void>,
  now = Date.now,
  wait = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const remaining = (progress.nextRequestAt ?? 0) - now();
  if (remaining > 0) await wait(remaining);
  try {
    return await read();
  } catch (error) {
    if ((error as { status?: number }).status === 429) {
      progress.requestInterval = (progress.requestInterval ?? 500) * 2;
    }
    throw error;
  } finally {
    progress.nextRequestAt = now() + (progress.requestInterval ?? 500);
    await save();
  }
}
