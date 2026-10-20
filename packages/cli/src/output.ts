import { hintForExitCode, type JobSource } from '@testbox/shared';

export interface TextSink {
  write(chunk: string): void;
}

export interface Summary {
  jobId?: string;
  state?: string;
  /** The job's own process status. */
  exitCode: number | null;
  error?: string | null;
  ok?: boolean;
  source?: JobSource;
  /** The CLI's exit status; the `--json` summary carries it with a hint. */
  exit: number;
  /** What to do, in one line. Defaults to the hint of `exit`; a command can say something more exact. */
  hint?: string;
  /** Where the job log was written, when it was. */
  logFile?: string;
  [extra: string]: unknown;
}

export class Output {
  constructor(
    readonly json: boolean,
    private readonly stdout: TextSink,
    private readonly stderr: TextSink,
    private readonly quiet = false,
  ) {}

  line(stream: 'stdout' | 'stderr', text: string): void {
    if (this.quiet) return;
    if (this.json) {
      this.stdout.write(`${JSON.stringify({ type: 'log', stream, line: text })}\n`);
      return;
    }
    const target = stream === 'stdout' ? this.stdout : this.stderr;
    target.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  info(text: string): void {
    if (this.json) this.stdout.write(`${JSON.stringify({ type: 'info', line: text })}\n`);
    else this.stderr.write(`${text}\n`);
  }

  error(text: string): void {
    if (this.json) this.stdout.write(`${JSON.stringify({ type: 'error', line: text })}\n`);
    else this.stderr.write(`${text}\n`);
  }

  event(event: Record<string, unknown>): void {
    if (this.json) this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  /**
   * The last line of a command. With `--json` it is always printed, also when the
   * command failed before a job existed, so a caller can read one line to know the result.
   */
  summary(summary: Summary): void {
    if (this.json) {
      const hint = summary.hint ?? hintForExitCode(summary.exit);
      this.stdout.write(`${JSON.stringify({ type: 'summary', ...summary, ...(hint ? { hint } : {}) })}\n`);
      return;
    }
    if (summary.jobId) {
      this.stdout.write(`job ${summary.jobId} ${summary.state ?? ''} exit=${summary.exitCode ?? ''}\n`);
    } else if (summary.error) {
      this.stderr.write(`${summary.error}\n`);
    }
    if (summary.logFile) this.stderr.write(`log: ${summary.logFile}\n`);
  }

  /** A command that stops with an error: the message, and with `--json` the summary line. */
  failure(message: string, exit: number): void {
    if (this.json) {
      this.summary({ state: 'error', exitCode: null, error: message, exit });
      return;
    }
    this.stderr.write(`${message}\n`);
  }
}
