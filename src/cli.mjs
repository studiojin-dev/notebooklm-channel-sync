#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.mjs";
import { loadConfig, ensureRequiredSyncConfig } from "./config.mjs";
import { readJson, writeJsonAtomic } from "./json-store.mjs";
import {
  createEmptyManifest,
  createEmptyState,
  upsertManifestEntry,
  buildStateFromManifest,
  selectPendingVideos,
  ARTIFACT_STATUS,
} from "./state-machine.mjs";
import { fetchChannelFeed, resolveChannelId } from "./youtube.mjs";
import { NotebookLmSidecar } from "./mcp-sidecar.mjs";
import { NotebookLmStudioSession } from "./notebooklm-browser.mjs";


function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = new Set(rest.filter((item) => item.startsWith("--")));
  return {
    command,
    dryRun: flags.has("--dry-run"),
    verbose: flags.has("--verbose"),
  };
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function cooldownBetweenVideos(config, logger, remainingCount) {
  if (remainingCount <= 0) return;
  const min = Math.max(0, config.videoDelayMinMs ?? 0);
  const max = Math.max(min, config.videoDelayMaxMs ?? min);
  const delayMs = randomBetween(min, max);
  logger.info(
    `Cooling down for ${Math.round(delayMs / 1000)}s before next video (${remainingCount} remaining).`,
  );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildNotebookMetadata(video, notebookUrl, artifactResult, config) {
  const dateTag = video.publishedAt.slice(0, 10);
  const channelSlug =
    config.youtubeChannelUrl
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/^@/, "") || "youtube-channel";

  return {
    url: notebookUrl,
    name: video.title,
    description: `YouTube video notebook for ${video.title}`,
    topics: [channelSlug, "youtube", "video transcript"],
    content_types: ["youtube", "video", "transcript"],
    use_cases: [
      `Review ${video.title}`,
      "Generate shareable NotebookLM artifacts",
    ],
    tags: ["youtube", channelSlug, dateTag, "studio-generated"],
  };
}

async function ensureWritablePaths(config) {
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  await fs.mkdir(path.dirname(config.manifestFile), { recursive: true });
}

async function runAuth(config, logger) {
  const sidecar = new NotebookLmSidecar(config, logger);
  try {
    const result = await sidecar.setupAuth();
    return result;
  } finally {
    await sidecar.close();
  }
}

async function runStatus(config, logger) {
  const sidecar = new NotebookLmSidecar(config, logger);
  try {
    const state = await readJson(
      config.stateFile,
      createEmptyState(config.youtubeChannelUrl, config.youtubeChannelId),
    );
    const manifest = await readJson(
      config.manifestFile,
      createEmptyManifest(config.youtubeChannelUrl, config.youtubeChannelId),
    );

    let health = null;
    try {
      health = await sidecar.getHealth();
    } catch (error) {
      health = {
        status: "error",
        authenticated: false,
        error: error.message,
      };
    }

    let channel = null;
    if (config.youtubeChannelUrl || config.youtubeChannelId) {
      try {
        channel = await resolveChannelId(config);
      } catch (error) {
        channel = { error: error.message };
      }
    }

    const summary = manifest.items.reduce((accumulator, item) => {
      accumulator[item.runStatus] = (accumulator[item.runStatus] || 0) + 1;
      return accumulator;
    }, {});

    return {
      command: "status",
      authenticated: health?.authenticated ?? false,
      health,
      channel,
      notebooklmDataDir: config.notebooklmDataDir,
      stateFile: config.stateFile,
      manifestFile: config.manifestFile,
      trackedVideos: manifest.items.length,
      statuses: summary,
      lastRunAt: state.lastRunAt,
    };
  } finally {
    await sidecar.close();
  }
}

function collectManifestUpdate(baseEntry, workflowResult, libraryNotebookId) {
  const artifactsUpdate = {};
  let anyError = null;

  if (workflowResult.artifacts) {
    for (const [key, result] of Object.entries(workflowResult.artifacts)) {
      artifactsUpdate[key] = {
        status: result.status,
        link: result.link,
      };
      if (result.error && !anyError) anyError = result.error;
    }
  }

  const update = {
    notebookUrl: workflowResult.notebookUrl || baseEntry.notebookUrl,
    libraryNotebookId: libraryNotebookId || baseEntry.libraryNotebookId,
    error: anyError,
    artifacts: artifactsUpdate,
  };
  return update;
}

async function syncVideo(video, manifest, sidecar, studio, config, logger) {
  const currentEntry =
    manifest.items.find((item) => item.videoId === video.videoId) || null;

  let workingManifest = upsertManifestEntry(manifest, {
    videoId: video.videoId,
    title: video.title,
    videoUrl: video.videoUrl,
    publishedAt: video.publishedAt,
    error: null,
  });

  try {
    const workflowResult = await studio.processVideo(video);
    const existingNotebooks = await sidecar.listNotebooks();
    const matchedLibraryEntry = existingNotebooks.find(
      (entry) => entry.url === workflowResult.notebookUrl,
    );
    let libraryNotebookId = matchedLibraryEntry?.id || currentEntry?.libraryNotebookId || null;

    if (!libraryNotebookId) {
      const notebook = await sidecar.addNotebook(
        buildNotebookMetadata(video, workflowResult.notebookUrl, workflowResult, config),
      );
      libraryNotebookId = notebook.id;
    }

    workingManifest = upsertManifestEntry(workingManifest, {
      videoId: video.videoId,
      ...collectManifestUpdate(currentEntry || {}, workflowResult, libraryNotebookId),
    });

    return {
      manifest: workingManifest,
      success: true,
    };
  } catch (error) {
    const stageStatus =
      error.stageStatus ||
      (String(error.message || "")
        .toLowerCase()
        .includes("quota")
        ? ARTIFACT_STATUS.QUOTA_BLOCKED
        : ARTIFACT_STATUS.FAILED);

    const artifactsUpdate = {};
    if (config && config.autoGenerateArtifacts) {
      for (const artifactName of config.autoGenerateArtifacts) {
        artifactsUpdate[artifactName] = {
          status: stageStatus,
          link: null,
        };
      }
    }

    workingManifest = upsertManifestEntry(workingManifest, {
      videoId: video.videoId,
      runStatus: stageStatus === ARTIFACT_STATUS.QUOTA_BLOCKED ? "quota_blocked" : stageStatus === ARTIFACT_STATUS.SOURCE_MISSING ? "source_missing" : "failed",
      error: error.message,
      artifacts: artifactsUpdate,
    });

    logger.warn(`Video ${video.videoId} failed: ${error.message}`);
    return {
      manifest: workingManifest,
      success: false,
    };
  }
}

async function runSync(config, logger, { dryRun }) {
  ensureRequiredSyncConfig(config);
  await ensureWritablePaths(config);

  const sidecar = new NotebookLmSidecar(config, logger);
  const state = await readJson(
    config.stateFile,
    createEmptyState(config.youtubeChannelUrl, config.youtubeChannelId),
  );
  let manifest = await readJson(
    config.manifestFile,
    createEmptyManifest(config.youtubeChannelUrl, config.youtubeChannelId),
  );

  try {
    const channel = await resolveChannelId(config);
    const feed = await fetchChannelFeed(channel.channelId);
    const pendingVideos = selectPendingVideos(
      feed.videos,
      state,
      config.backfillCount,
    ).slice(0, config.maxVideosPerRun);

    const health = await sidecar.getHealth();
    const summary = {
      channel,
      feedUrl: feed.feedUrl,
      pendingVideos,
      authenticated: health.authenticated,
    };

    if (dryRun) {
      return { command: "sync", dryRun: true, ...summary };
    }

    if (!health.authenticated) {
      throw new Error("NotebookLM authentication is not ready. `auth` 명령을 먼저 실행하세요.");
    }

    manifest.channelId = channel.channelId;
    manifest.channelUrl = config.youtubeChannelUrl;

    if (pendingVideos.length === 0) {
      manifest.updatedAt = new Date().toISOString();
      await writeJsonAtomic(config.manifestFile, manifest);
      const idleState = buildStateFromManifest(
        {
          ...state,
          channelId: channel.channelId,
          channelUrl: config.youtubeChannelUrl,
          initializedAt: state.initializedAt || new Date().toISOString(),
        },
        manifest,
      );
      idleState.lastRunAt = manifest.updatedAt;
      await writeJsonAtomic(config.stateFile, idleState);
      return {
        command: "sync",
        dryRun: false,
        channel,
        processed: 0,
        maxVideosPerRun: config.maxVideosPerRun,
        manifestFile: config.manifestFile,
        stateFile: config.stateFile,
      };
    }

    const studio = new NotebookLmStudioSession(config, logger);
    await studio.init();
    try {
      for (const [index, video] of pendingVideos.entries()) {
        logger.info(`Syncing ${video.videoId} - ${video.title}`);
        const result = await syncVideo(video, manifest, sidecar, studio, config, logger);
        manifest = result.manifest;
        await writeJsonAtomic(config.manifestFile, manifest);
        const nextState = buildStateFromManifest(
          {
            ...state,
            channelId: channel.channelId,
            channelUrl: config.youtubeChannelUrl,
            initializedAt: state.initializedAt || new Date().toISOString(),
          },
          manifest,
        );
        nextState.lastRunAt = new Date().toISOString();
        await writeJsonAtomic(config.stateFile, nextState);
        await cooldownBetweenVideos(
          config,
          logger,
          pendingVideos.length - index - 1,
        );
      }
    } finally {
      await studio.close();
    }

    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(config.manifestFile, manifest);
    const finalState = buildStateFromManifest(
      {
        ...state,
        channelId: channel.channelId,
        channelUrl: config.youtubeChannelUrl,
        initializedAt: state.initializedAt || new Date().toISOString(),
      },
      manifest,
    );
    finalState.lastRunAt = manifest.updatedAt;
    await writeJsonAtomic(config.stateFile, finalState);

    return {
      command: "sync",
      dryRun: false,
      channel,
      processed: pendingVideos.length,
      maxVideosPerRun: config.maxVideosPerRun,
      manifestFile: config.manifestFile,
      stateFile: config.stateFile,
    };
  } finally {
    await sidecar.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const logger = createLogger({
    level: args.verbose ? "debug" : "info",
  });

  switch (args.command) {
    case "auth":
      console.log(JSON.stringify(await runAuth(config, logger), null, 2));
      break;
    case "sync":
      console.log(JSON.stringify(await runSync(config, logger, { dryRun: args.dryRun }), null, 2));
      break;
    case "status":
      console.log(JSON.stringify(await runStatus(config, logger), null, 2));
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

export { runAuth, runStatus, runSync };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          error: error.message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
