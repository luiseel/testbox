import { EventEmitter } from 'events';

export interface InterruptOptions {
  signals: EventEmitter;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
  cancel: () => void;
  detach: () => void;
}

/** First Ctrl-C on a TTY asks cancel vs detach. A second Ctrl-C, or any Ctrl-C without a TTY, cancels. */
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
  opts.signals.on('SIGINT', onSig);
  return () => {
    opts.signals.off('SIGINT', onSig);
  };
}
