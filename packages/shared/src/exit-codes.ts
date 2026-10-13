import type { JobState } from './states';

export const ExitCode = {
  Pass: 0,
  JobFailed: 1,
  SyncError: 10,
  NoWorker: 11,
  Timeout: 12,
  Cancelled: 13,
  Auth: 20,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** CLI process status. The job's raw process status is reported separately. */
export function exitCodeForJob(state: JobState): number {
  switch (state) {
    case 'succeeded':
      return ExitCode.Pass;
    case 'timed_out':
      return ExitCode.Timeout;
    case 'cancelled':
      return ExitCode.Cancelled;
    case 'failed':
      return ExitCode.JobFailed;
    default:
      return ExitCode.JobFailed;
  }
}

export function exitCodeForApiError(code: string, status?: number): number {
  if (code === 'AUTH' || status === 401 || status === 403) return ExitCode.Auth;
  if (code === 'NO_WORKER' || status === 503) return ExitCode.NoWorker;
  if (code === 'SYNC') return ExitCode.SyncError;
  if (code === 'TIMEOUT') return ExitCode.Timeout;
  if (code === 'CANCELLED') return ExitCode.Cancelled;
  return ExitCode.JobFailed;
}
