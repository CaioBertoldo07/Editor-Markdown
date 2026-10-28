/**
 * Fila de compilações: `concurrency` slots (cada um com o seu UID), fila de
 * espera limitada e tempo máximo de espera. Pedidos cancelados enquanto
 * esperam saem da fila sem ocupar slot.
 */

export class BusyError extends Error {
  constructor(public readonly reason: 'queue_full' | 'queue_timeout') {
    super(reason);
  }
}

type Waiter = { resolve: (slot: number) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class SlotPool {
  private free: number[];
  private waiting: Waiter[] = [];

  constructor(
    concurrency: number,
    private readonly maxQueue: number,
    private readonly maxWaitMs: number
  ) {
    this.free = Array.from({ length: concurrency }, (_, i) => i + 1);
  }

  get stats() {
    return { free: this.free.length, waiting: this.waiting.length };
  }

  acquire(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const slot = this.free.shift();
    if (slot !== undefined) return Promise.resolve(slot);
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new BusyError('queue_full'));

    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(new BusyError('queue_timeout'));
        }, this.maxWaitMs),
      };
      this.waiting.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          if (this.remove(waiter)) reject(new Error('aborted'));
        },
        { once: true }
      );
    });
  }

  release(slot: number) {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(slot);
    } else {
      this.free.push(slot);
    }
  }

  private remove(waiter: Waiter): boolean {
    const index = this.waiting.indexOf(waiter);
    if (index === -1) return false;
    clearTimeout(waiter.timer);
    this.waiting.splice(index, 1);
    return true;
  }
}
