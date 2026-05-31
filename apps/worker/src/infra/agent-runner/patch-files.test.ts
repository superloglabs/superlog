import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { downloadAgentPatchFile } from "./patch-files.js";

const originalModule = process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE;

afterEach(() => {
  if (originalModule === undefined) process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE = undefined;
  else process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE = originalModule;
});

test("downloadAgentPatchFile delegates to the configured downloader module", async () => {
  process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE =
    "data:text/javascript,export async function downloadAgentPatchFile(input) { return { patch: 'diff --git a/a b/a\\n', fileId: input.patchFileId }; }";

  const result = await downloadAgentPatchFile({
    sessionId: "session-1",
    patchFileId: "file-1",
  });

  assert.deepEqual(result, { patch: "diff --git a/a b/a\n", fileId: "file-1" });
});

test("downloadAgentPatchFile fails clearly when no downloader can be loaded", async () => {
  process.env.AGENT_PATCH_FILE_DOWNLOADER_MODULE = "./missing-patch-downloader.js";

  await assert.rejects(
    () => downloadAgentPatchFile({ sessionId: "session-1", patchFileId: "file-1" }),
    /agent patch file downloads are not configured/,
  );
});
