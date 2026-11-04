// Better Auth refuses invitation reads and acceptance for an unverified address
// when the organization plugin sets requireEmailVerificationOnInvitation. The two
// endpoints word the tail differently ("for invitation" vs "before accepting or
// rejecting invitation"), so match the shared prefix.
const EMAIL_VERIFICATION_REQUIRED = "email verification required";

export function isEmailVerificationRequiredError(message: string | null | undefined): boolean {
  return (message ?? "").toLowerCase().includes(EMAIL_VERIFICATION_REQUIRED);
}
