export const RUN_STATUS = {
  PENDING: "pending",
  NOTEBOOK_CREATED: "notebook_created",
  ARTIFACTS_GENERATED: "artifacts_generated",
  SHARE_LINK_UNAVAILABLE: "share_link_unavailable",
  SOURCE_MISSING: "source_missing",
  QUOTA_BLOCKED: "quota_blocked",
  COMPLETED: "completed",
  FAILED: "failed",
};

export const ARTIFACT_STATUS = {
  PENDING: "pending",
  GENERATED: "generated",
  SHARE_LINK_CAPTURED: "share_link_captured",
  SHARE_LINK_UNAVAILABLE: "share_link_unavailable",
  SOURCE_MISSING: "source_missing",
  QUOTA_BLOCKED: "quota_blocked",
  FAILED: "failed",
};

export function createEmptyState(channelUrl = "", channelId = "") {
  return {
    schemaVersion: 1,
    channelUrl,
    channelId,
    initializedAt: null,
    lastRunAt: null,
    videos: {},
  };
}

export function createEmptyManifest(channelUrl = "", channelId = "") {
  return {
    schemaVersion: 1,
    channelUrl,
    channelId,
    updatedAt: null,
    items: [],
  };
}

export function deriveRunStatus(entry) {
  const artifacts = entry.artifacts || {};
  if (entry.infographic) artifacts.Infographic = entry.infographic;
  if (entry.slideDeck) artifacts["Slide Deck"] = entry.slideDeck;

  const statuses = Object.values(artifacts).map(a => a.status);
  if (statuses.length === 0) statuses.push(ARTIFACT_STATUS.PENDING);

  if (
    entry.notebookUrl &&
    entry.libraryNotebookId &&
    statuses.every((status) => status === ARTIFACT_STATUS.SHARE_LINK_CAPTURED)
  ) {
    return RUN_STATUS.COMPLETED;
  }

  if (
    statuses.some((status) => status === ARTIFACT_STATUS.QUOTA_BLOCKED) ||
    entry.runStatus === RUN_STATUS.QUOTA_BLOCKED
  ) {
    return RUN_STATUS.QUOTA_BLOCKED;
  }

  if (
    statuses.some((status) => status === ARTIFACT_STATUS.SOURCE_MISSING) ||
    entry.runStatus === RUN_STATUS.SOURCE_MISSING
  ) {
    return RUN_STATUS.SOURCE_MISSING;
  }

  if (
    statuses.some((status) => status === ARTIFACT_STATUS.SHARE_LINK_UNAVAILABLE)
  ) {
    return RUN_STATUS.SHARE_LINK_UNAVAILABLE;
  }

  if (
    entry.notebookUrl &&
    statuses.every(
      (status) =>
        status === ARTIFACT_STATUS.GENERATED ||
        status === ARTIFACT_STATUS.SHARE_LINK_CAPTURED,
    )
  ) {
    return RUN_STATUS.ARTIFACTS_GENERATED;
  }

  if (entry.notebookUrl) {
    return RUN_STATUS.NOTEBOOK_CREATED;
  }

  return entry.runStatus || RUN_STATUS.PENDING;
}

export function shouldProcessEntry(entry) {
  return !entry || entry.runStatus !== RUN_STATUS.COMPLETED;
}

export function upsertManifestEntry(manifest, partialEntry) {
  const now = new Date().toISOString();
  const items = [...manifest.items];
  const index = items.findIndex((item) => item.videoId === partialEntry.videoId);
  const baseEntry =
    index === -1
      ? {
          videoId: partialEntry.videoId,
          title: partialEntry.title || "",
          videoUrl: partialEntry.videoUrl || "",
          publishedAt: partialEntry.publishedAt || "",
          notebookUrl: null,
          libraryNotebookId: null,
          runStatus: RUN_STATUS.PENDING,
          error: null,
          artifacts: {},
          createdAt: now,
          updatedAt: now,
        }
      : { ...items[index] };

  const merged = {
    ...baseEntry,
    ...partialEntry,
    artifacts: {
      ...(baseEntry.artifacts || {}),
    },
    updatedAt: now,
  };
  
  if (partialEntry.artifacts) {
    for (const [key, val] of Object.entries(partialEntry.artifacts)) {
      merged.artifacts[key] = { ...val, updatedAt: now };
    }
  }

  // Backwards compatibility migration
  if (baseEntry.infographic && !merged.artifacts.Infographic) merged.artifacts.Infographic = baseEntry.infographic;
  if (baseEntry.slideDeck && !merged.artifacts["Slide Deck"]) merged.artifacts["Slide Deck"] = baseEntry.slideDeck;
  
  delete merged.infographic;
  delete merged.slideDeck;
  merged.runStatus = deriveRunStatus(merged);

  if (index === -1) {
    items.push(merged);
  } else {
    items[index] = merged;
  }

  return {
    ...manifest,
    updatedAt: now,
    items,
  };
}

export function buildStateFromManifest(state, manifest) {
  const videos = {};
  for (const item of manifest.items) {
    videos[item.videoId] = {
      videoId: item.videoId,
      title: item.title,
      publishedAt: item.publishedAt,
      runStatus: item.runStatus,
      notebookUrl: item.notebookUrl,
      libraryNotebookId: item.libraryNotebookId,
      updatedAt: item.updatedAt,
      error: item.error,
    };
  }

  return {
    ...state,
    channelId: manifest.channelId || state.channelId,
    channelUrl: manifest.channelUrl || state.channelUrl,
    lastRunAt: manifest.updatedAt || state.lastRunAt,
    videos,
    initializedAt: state.initializedAt || manifest.updatedAt || new Date().toISOString(),
  };
}

export function selectPendingVideos(videos, state, backfillCount) {
  const sorted = [...videos].sort(
    (left, right) => new Date(right.publishedAt) - new Date(left.publishedAt),
  );

  const hasSeenAnyVideo = Object.keys(state.videos || {}).length > 0;
  if (!hasSeenAnyVideo) {
    return sorted.slice(0, backfillCount);
  }

  const pending = [];
  for (const video of sorted) {
    const entry = state.videos[video.videoId];
    if (!entry) {
      pending.push(video);
      continue;
    }
    if (shouldProcessEntry(entry)) {
      pending.push(video);
    }
  }

  return pending;
}
