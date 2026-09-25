/**
 * Stopping work that is already under way.
 *
 * A run or review registers itself by id while it executes; stopping it aborts
 * its signal. The pipeline checks the signal between steps (and between
 * features within the long AI steps), and the Playwright child process is
 * killed as soon as it fires. An AI call already in flight is allowed to
 * return, so a stop takes effect within one call, not instantly.
 */

export const STOPPED_MESSAGE = 'Stopped by a user.';

export class CancelledError extends Error {
  constructor() {
    super(STOPPED_MESSAGE);
    this.name = 'CancelledError';
  }
}

const controllers = new Map<string, AbortController>();

/** Registers work under an id and returns the signal it should watch. */
export function registerCancellable(id: string): AbortSignal {
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller.signal;
}

export function releaseCancellable(id: string): void {
  controllers.delete(id);
}

/** Aborts work registered in this process. False when nothing here is running it. */
export function cancel(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort(new CancelledError());
  return true;
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError;
}
