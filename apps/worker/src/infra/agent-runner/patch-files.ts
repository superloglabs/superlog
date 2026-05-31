type PatchFileDownloaderModule = {
  downloadAgentPatchFile(input: {
    sessionId: string;
    patchFileId?: string | null;
    patchFilePath?: string | null;
  }): Promise<{ patch: string; fileId: string }>;
};

export async function downloadAgentPatchFile(input: {
  sessionId: string;
  patchFileId?: string | null;
  patchFilePath?: string | null;
}): Promise<{ patch: string; fileId: string }> {
  const downloader = await importPatchFileDownloader();
  return downloader.downloadAgentPatchFile(input);
}

async function importPatchFileDownloader(): Promise<PatchFileDownloaderModule> {
  const specifier = process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE ?? "./anthropic-patch-files.js";
  try {
    return (await import(specifier)) as PatchFileDownloaderModule;
  } catch (err) {
    throw new Error(
      "agent patch file downloads are not configured; agent results must include inline patches",
      { cause: err },
    );
  }
}
