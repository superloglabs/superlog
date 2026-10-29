export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`${status}: ${body}`);
    this.name = "ApiError";
  }
}

// Matches the API's email-verification gate (`email_verification_required`,
// 403) in either ApiError form (`403: {"error":"..."}`) or raw message text.
// Used to swap in "verify your email first" copy wherever the error surfaces.
export function isEmailVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("email_verification_required");
}
