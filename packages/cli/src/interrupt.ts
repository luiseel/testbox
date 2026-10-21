import { EventEmitter } from 'events';

export interface InterruptOptions {
  signals: EventEmitter;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
  cancel: () => void;
  detach: () => void;
}

const DETACH_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;

/**
 * First Ctrl-C on a TTY asks cancel vs detach. A second Ctrl-C, or any Ctrl-C without a TTY, cancels.
 * SIGTERM and SIGHUP detach: a harness that kills the CLI on a time limit must not cancel the job.
 * The first SIGTERM or SIGHUP removes their handlers, so a second one ends the process at once.
 */
export function attachInterrupt(opts: InterruptOptions): () => void {
  let decided = false;
  let prompting = false;
  const onSig = () => {
    if (decided) return;
    if (!opts.isTTY || prompting) {
      decided = true;
      opts.cancel();
      return;
    }
    prompting = true;
    void opts.prompt('Cancel job or detach? [c/d] ').then((answer) => {
      if (decided) return;
      decided = true;
      if (answer.trim().toLowerCase().startsWith('d')) opts.detach();
      else opts.cancel();
    });
  };
  const offDetach = () => {
    for (const name of DETACH_SIGNALS) opts.signals.off(name, onDetach);
  };
  const onDetach = () => {
    offDetach();
    if (decided) return;
    decided = true;
    opts.detach();
  };
  opts.signals.on('SIGINT', onSig);
  for (const name of DETACH_SIGNALS) opts.signals.on(name, onDetach);
  return () => {
    opts.signals.off('SIGINT', onSig);
    offDetach();
  };
}
