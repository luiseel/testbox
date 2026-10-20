import type { JobState } from './states';

export const ExitCode = {
  Pass: 0,
  JobFailed: 1,
  Usage: 2,
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

/**
 * What to do about a CLI exit code, in one line. The `--json` summary carries it,
 * so a caller (a person or an agent) does not need the docs to act on a failure.
 */
export function hintForExitCode(code: number): string | undefined {
  switch (code) {
    case ExitCode.Pass:
      return undefined;
    case ExitCode.JobFailed:
      return 'the command failed on the worker: read the log and fix the code';
    case ExitCode.Usage:
      return 'bad arguments or testbox.yml: fix the command line or the config, not the code';
    case ExitCode.SyncError:
      return 'file sync failed: run testbox doctor';
    case ExitCode.NoWorker:
      return 'no usable worker: run testbox doctor; if the labels are wrong, fix requires in testbox.yml';
    case ExitCode.Timeout:
      return 'timeout or worker lost: raise --timeout or find the hang; for lease_expired run testbox doctor';
    case ExitCode.Cancelled:
      return 'cancelled: someone cancelled it, or a newer submit of the same profile replaced it';
    case ExitCode.Auth:
      return 'not logged in or bad token: ask an admin for a new testbox setup line';
    default:
      return undefined;
  }
}
