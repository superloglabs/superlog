export class MetricReadBudget {
  readonly month: string;
  private count: number;

  private constructor(
    month: string,
    seriesRead: number,
    readonly monthlyLimit: number,
  ) {
    this.month = month;
    this.count = seriesRead;
  }

  static restore(input: {
    month: string | null;
    seriesRead: number;
    monthlyLimit: number;
    now: Date;
  }): MetricReadBudget {
    if (!Number.isSafeInteger(input.monthlyLimit) || input.monthlyLimit < 0) {
      throw new Error("monthly metric read limit must be a non-negative safe integer");
    }
    const currentMonth = input.now.toISOString().slice(0, 7);
    const seriesRead = input.month === currentMonth ? input.seriesRead : 0;
    if (!Number.isSafeInteger(seriesRead) || seriesRead < 0) {
      throw new Error("returned metric series count must be a non-negative safe integer");
    }
    return new MetricReadBudget(
      currentMonth,
      Math.min(seriesRead, input.monthlyLimit),
      input.monthlyLimit,
    );
  }

  get seriesRead(): number {
    return this.count;
  }

  get remaining(): number {
    return Math.max(0, this.monthlyLimit - this.count);
  }

  nextPageSize(preferred: number): number {
    if (!Number.isSafeInteger(preferred) || preferred < 1) return 0;
    return Math.min(preferred, this.remaining);
  }

  recordReturnedSeries(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("returned metric series count must be a non-negative safe integer");
    }
    if (count > this.remaining) throw new Error("monthly metric read budget exhausted");
    this.count += count;
  }

  refundReservedSeries(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.count) {
      throw new Error("metric series refund must be a valid reserved count");
    }
    this.count -= count;
  }
}
