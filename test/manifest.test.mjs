import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyManifest,
  upsertManifestEntry,
  ARTIFACT_STATUS,
} from "../src/state-machine.mjs";

test("upsertManifestEntry preserves existing fields while merging artifact updates", () => {
  let manifest = createEmptyManifest();
  manifest = upsertManifestEntry(manifest, {
    videoId: "video-1",
    title: "Demo",
    notebookUrl: "https://notebooklm.google.com/notebook/1",
  });

  manifest = upsertManifestEntry(manifest, {
    videoId: "video-1",
    infographic: {
      status: ARTIFACT_STATUS.SHARE_LINK_CAPTURED,
      link: "https://example.com/i",
    },
  });

  assert.equal(manifest.items.length, 1);
  assert.equal(
    manifest.items[0].notebookUrl,
    "https://notebooklm.google.com/notebook/1",
  );
  assert.equal(
    manifest.items[0].infographic.link,
    "https://example.com/i",
  );
  assert.equal(manifest.items[0].slideDeck.link, null);
});
