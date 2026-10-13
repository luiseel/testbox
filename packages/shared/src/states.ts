export const JOB_STATES = [
  'queued',
  'assigned',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['assigned', 'cancelled'],
  assigned: ['running', 'cancelled', 'timed_out'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Completed jobs are terminal. Callers must not schedule another attempt
 * for the same job id; a retry is a new job.
 */
export function assertTransition(from: JobState, to: JobState): void {
  if (isTerminal(from)) {
    throw new IllegalTransitionError(
      `job is ${from}; a completed job is never re-executed`,
    );
  }
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(`cannot transition ${from} -> ${to}`);
  }
}
