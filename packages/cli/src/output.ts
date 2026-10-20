import type { JobSource } from '@testbox/shared';

export interface TextSink {
  write(chunk: string): void;
}

export interface Summary {
  jobId?: string;
  state?: string;
  exitCode: number | null;
  error?: string | null;
  ok?: boolean;
  source?: JobSource;
}

export class Output {
  constructor(
    readonly json: boolean,
    private readonly stdout: TextSink,
    private readonly stderr: TextSink,
  ) {}

  line(stream: 'stdout' | 'stderr', text: string): void {
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

  summary(summary: Summary): void {
    if (this.json) {
      this.stdout.write(`${JSON.stringify({ type: 'summary', ...summary })}\n`);
      return;
    }
    if (summary.jobId) {
      this.stdout.write(`job ${summary.jobId} ${summary.state ?? ''} exit=${summary.exitCode ?? ''}\n`);
    } else if (summary.error) {
      this.stderr.write(`${summary.error}\n`);
    }
  }
}
