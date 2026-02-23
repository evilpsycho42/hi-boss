export class AsyncSemaphore {
  private inUse = 0;
  private capacity: number;
  private waiters: Array<(release: () => void) => void> = [];

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be >= 1");
    }
    this.capacity = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.inUse < this.capacity) {
      this.inUse++;
      return this.releaseFactory();
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
      this.flushWaiters();
    };
  }

  setCapacity(capacity: number): void {
    if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be >= 1");
    }
    this.capacity = capacity;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    while (this.inUse < this.capacity) {
      const next = this.waiters.shift();
      if (!next) {
        break;
      }
      this.inUse++;
      next(this.releaseFactory());
    }
  }
}
