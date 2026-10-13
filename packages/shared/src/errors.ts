export type AppErrorCode =
  | 'AUTH'
  | 'NO_WORKER'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'SYNC'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
