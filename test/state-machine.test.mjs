import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyState,
  selectPendingVideos,
  upsertManifestEntry,
  createEmptyManifest,
  RUN_STATUS,
  ARTIFACT_STATUS,
} from "../src/state-machine.mjs";

test("initial run only backfills configured number of videos", () => {
  const state = createEmptyState();
  const videos = [
    { videoId: "a", publishedAt: "2026-04-12T00:00:00Z" },
    { videoId: "b", publishedAt: "2026-04-11T00:00:00Z" },
    { videoId: "c", publishedAt: "2026-04-10T00:00:00Z" },
  ];

  const selected = selectPendingVideos(videos, state, 2);
  assert.deepEqual(
    selected.map((item) => item.videoId),
    ["a", "b"],
  );
});

test("completed videos are skipped but retriable ones remain pending", () => {
  const state = createEmptyState();
  state.videos = {
    a: { videoId: "a", runStatus: RUN_STATUS.COMPLETED },
    b: { videoId: "b", runStatus: RUN_STATUS.SHARE_LINK_UNAVAILABLE },
  };
  const videos = [
    { videoId: "a", publishedAt: "2026-04-12T00:00:00Z" },
    { videoId: "b", publishedAt: "2026-04-11T00:00:00Z" },
    { videoId: "c", publishedAt: "2026-04-10T00:00:00Z" },
  ];

  const selected = selectPendingVideos(videos, state, 5);
  assert.deepEqual(
    selected.map((item) => item.videoId),
    ["b", "c"],
  );
});

test("upsertManifestEntry derives completed status only after both links exist", () => {
  let manifest = createEmptyManifest();
  manifest = upsertManifestEntry(manifest, {
    videoId: "video-1",
    title: "Demo",
    notebookUrl: "https://notebooklm.google.com/notebook/1",
    libraryNotebookId: "demo",
    infographic: {
      status: ARTIFACT_STATUS.SHARE_LINK_CAPTURED,
      link: "https://example.com/infographic",
    },
    slideDeck: {
      status: ARTIFACT_STATUS.SHARE_LINK_CAPTURED,
      link: "https://example.com/slides",
    },
  });

  assert.equal(manifest.items[0].runStatus, RUN_STATUS.COMPLETED);
});
