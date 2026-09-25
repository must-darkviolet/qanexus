export class AppError extends Error {
  constructor(message: string, readonly status = 500, readonly code = 'internal_error', readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, details?: unknown) => new AppError(m, 400, 'bad_request', details);
export const notFound = (m: string) => new AppError(m, 404, 'not_found');
export const conflict = (m: string) => new AppError(m, 409, 'conflict');
export const notImplemented = (m: string) => new AppError(m, 501, 'not_implemented');

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
