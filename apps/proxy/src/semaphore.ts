/**
 * A counting semaphore used to bound how many ingest requests buffer/stream
 * concurrently. Combined with the per-request body cap, this makes the proxy's
 * memory footprint a provable constant:
 *
 *   max_memory  ≈  permits  ×  max_bytes_held_per_request
 *
 * Acquisition is FIFO and `await`-based: a request that arrives when all permits
 * are taken *waits* for one to free up rather than being rejected. That is the
 * deliberate design choice — backpressure (the waiter holds only its socket +
 * a pending promise, not a body buffer) instead of shedding valid traffic. The
 * body is only read after a permit is held, so waiters cost ~nothing.
 *
 * A permit count of <= 0 disables the limiter (acquire resolves immediately,
 * release is a no-op) — an escape hatch via INGEST_MAX_INFLIGHT_REQUESTS=0.
 */

// Linked-list node for the FIFO waiter queue. A linked list gives O(1) push
// and shift — `Array.shift()` is O(n) and creates superlinear CPU pressure
// under burst load when many requests queue on the semaphore simultaneously.
type WaiterNode = {
  resolve: () => void;
  next: WaiterNode | null;
};

export class Semaphore {
  private readonly limited: boolean;
  private available: number;
  private head: WaiterNode | null = null;
  private tail: WaiterNode | null = null;
  private waitersLength = 0;

  constructor(permits: number) {
    this.limited = permits > 0;
    this.available = this.limited ? permits : 0;
  }

  acquire(): Promise<void> {
    if (!this.limited) return Promise.resolve();
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const node: WaiterNode = { resolve, next: null };
      if (this.tail) {
        this.tail.next = node;
      } else {
        this.head = node;
      }
      this.tail = node;
      this.waitersLength += 1;
    });
  }

  release(): void {
    if (!this.limited) return;
    const head = this.head;
    if (head) {
      // Hand the permit straight to the next waiter without round-tripping
      // through `available`, so a steady stream of releases keeps the queue
      // draining in FIFO order.
      this.head = head.next;
      if (!this.head) this.tail = null;
      this.waitersLength -= 1;
      head.resolve();
      return;
    }
    this.available += 1;
  }

  get availablePermits(): number {
    return this.available;
  }

  get queueLength(): number {
    return this.waitersLength;
  }
}
