export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`${status}: ${body}`);
    this.name = "ApiError";
  }
}
