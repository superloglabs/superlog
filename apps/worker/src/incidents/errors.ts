export class IssueGroupingFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueGroupingFailedError";
  }
}
