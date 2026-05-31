import { redactGitSecrets } from "../github-app.js";

const DEFAULT_PR_OPEN_FAILURE_SUMMARY = "Failed to validate or open the PR.";
const MAX_PR_OPEN_FAILURE_DETAIL_LENGTH = 320;

export function summarizePrOpenFailure(err: unknown): string {
  const detail = firstUsefulLine(redactGitSecrets(publicErrorDetail(err)));
  if (!detail) return DEFAULT_PR_OPEN_FAILURE_SUMMARY;
  return `Failed to open the PR: ${truncate(detail, MAX_PR_OPEN_FAILURE_DETAIL_LENGTH)}`;
}

function publicErrorDetail(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const detail = (err as { publicDetail?: unknown }).publicDetail;
  if (typeof detail === "string") return detail;
  if (err instanceof Error) return err.message;
  return String(err);
}

function firstUsefulLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}
