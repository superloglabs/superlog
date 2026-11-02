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

// Singly-linked list node for the FIFO waiter queue. Using a linked list keeps
// both enqueue (push to tail) and dequeue (pop from head) O(1). The previous
// Array-based implementation called Array.shift() in release(), which is O(n)
// because it copies every remaining element one slot forward. Under burst
// concurrency where multiple requests queue on the semaphore, repeated O(n)
// shifts produce O(n²) total work — a superlinear CPU spike that shows up as
// elevated event-loop utilization.
type WaiterNode = { fn: () => void; next: WaiterNode | null };

export class Semaphore {
  private readonly limited: boolean;
  private available: number;
  private waiterHead: WaiterNode | null = null;
  private waiterTail: WaiterNode | null = null;
  private waiterCount = 0;

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
      const node: WaiterNode = { fn: resolve, next: null };
      if (this.waiterTail) {
        this.waiterTail.next = node;
      } else {
        this.waiterHead = node;
      }
      this.waiterTail = node;
      this.waiterCount += 1;
    });
  }

  release(): void {
    if (!this.limited) return;
    const node = this.waiterHead;
    if (node) {
      // Hand the permit straight to the next waiter without round-tripping
      // through `available`, so a steady stream of releases keeps the queue
      // draining in FIFO order.
      this.waiterHead = node.next;
      if (this.waiterHead === null) this.waiterTail = null;
      this.waiterCount -= 1;
      node.fn();
      return;
    }
    this.available += 1;
  }

  get availablePermits(): number {
    return this.available;
  }

  get queueLength(): number {
    return this.waiterCount;
  }
}
