import assert from "node:assert/strict";
import test from "node:test";

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      maxTouchPoints: 0,
      platform: "Linux",
      userAgent: "node.js",
    },
  });
}

const { parseIncidentPrPatchFiles, visibleIncidentPrDiffFiles } = await import(
  "./incident-pr-diff-model.ts"
);

const MULTI_FILE_PATCH = `diff --git a/apps/api/src/checkout.ts b/apps/api/src/checkout.ts
index 4f52110..ab9e031 100644
--- a/apps/api/src/checkout.ts
+++ b/apps/api/src/checkout.ts
@@ -18,1 +18,2 @@ export async function createCheckoutSession(cart: Cart) {
-  const couponCode = cart.metadata.couponCode;
+  const metadata = cart.metadata ?? {};
+  const couponCode = metadata.couponCode ?? null;
diff --git a/apps/api/src/checkout.test.ts b/apps/api/src/checkout.test.ts
new file mode 100644
index 0000000..441f0f8
--- /dev/null
+++ b/apps/api/src/checkout.test.ts
@@ -0,0 +1,3 @@
+import test from "node:test";
+
+test("handles missing metadata", () => {});
`;

test("parses every file in a multi-file incident PR patch", () => {
  const files = parseIncidentPrPatchFiles(MULTI_FILE_PATCH);

  assert.deepEqual(
    files.map((file) => file.name),
    ["apps/api/src/checkout.ts", "apps/api/src/checkout.test.ts"],
  );
});

test("shows every parsed file when no file is selected", () => {
  const files = parseIncidentPrPatchFiles(MULTI_FILE_PATCH);

  assert.deepEqual(visibleIncidentPrDiffFiles(files, null), files);
});

test("shows one parsed file when a file is selected", () => {
  const files = parseIncidentPrPatchFiles(MULTI_FILE_PATCH);

  assert.deepEqual(
    visibleIncidentPrDiffFiles(files, "apps/api/src/checkout.test.ts").map((file) => file.name),
    ["apps/api/src/checkout.test.ts"],
  );
});
