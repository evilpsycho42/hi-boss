export class AsyncSemaphore {
  private inUse = 0;
  private waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be >= 1");
    }
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
      const next = this.waiters.shift();
      if (next) {
        this.inUse++;
        next(this.releaseFactory());
      }
    };
  }
}
