import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export type IncidentPrDiffFile = FileDiffMetadata;

export function parseIncidentPrPatchFiles(patch: string): IncidentPrDiffFile[] {
  try {
    return parsePatchFiles(patch, "incident-pr", true).flatMap((parsed) => parsed.files);
  } catch {
    return [];
  }
}

export function visibleIncidentPrDiffFiles(
  files: IncidentPrDiffFile[],
  selectedFileName: string | null,
): IncidentPrDiffFile[] {
  if (!selectedFileName) return files;
  const selectedFile = files.find((file) => file.name === selectedFileName);
  return selectedFile ? [selectedFile] : files;
}
