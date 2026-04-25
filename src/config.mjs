import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseArray(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return String(value).split(",").map(s => s.trim()).filter(Boolean);
}

function platformDefaultNotebooklmDataDir(platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "notebooklm-mcp");
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "notebooklm-mcp");
  }
  return path.join(home, ".local", "share", "notebooklm-mcp");
}

export function loadConfig(env = process.env) {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(thisFile), "..");
  const defaultNotebooklmDataDir = platformDefaultNotebooklmDataDir();
  const notebooklmDataDir = path.resolve(
    env.NOTEBOOKLM_DATA_DIR || defaultNotebooklmDataDir,
  );
  const dataDir = path.join(projectRoot, "data");

  return {
    projectRoot,
    dataDir,
    youtubeChannelUrl: env.YOUTUBE_CHANNEL_URL || "",
    youtubeChannelId: env.YOUTUBE_CHANNEL_ID || "",
    backfillCount: parseInteger(env.BACKFILL_COUNT, 5),
    maxVideosPerRun: parseInteger(env.MAX_VIDEOS_PER_RUN, 5),
    headless: parseBoolean(env.HEADLESS, true),
    allowPublicShare: parseBoolean(env.ALLOW_PUBLIC_SHARE, false),
    autoGenerateArtifacts: parseArray(env.AUTO_GENERATE_ARTIFACTS, ["Slide Deck"]),
    browserTimeoutMs: parseInteger(env.BROWSER_TIMEOUT_MS, 60000),
    videoDelayMinMs: parseInteger(env.VIDEO_DELAY_MIN_MS, 60000),
    videoDelayMaxMs: parseInteger(env.VIDEO_DELAY_MAX_MS, 300000),
    indexingSettleMs: parseInteger(env.INDEXING_SETTLE_MS, 30000),
    artifactStageDelayMs: parseInteger(env.ARTIFACT_STAGE_DELAY_MS, 15000),
    notebooklmDataDir,
    defaultNotebooklmDataDir,
    chromeProfileDir: path.join(notebooklmDataDir, "chrome_profile"),
    browserStateDir: path.join(notebooklmDataDir, "browser_state"),
    libraryPath: path.join(notebooklmDataDir, "library.json"),
    stateFile: path.resolve(env.STATE_FILE || path.join(dataDir, "state.json")),
    manifestFile: path.resolve(
      env.MANIFEST_FILE || path.join(dataDir, "manifest.json"),
    ),
    mcpServerScript: path.join(
      projectRoot,
      "node_modules",
      "notebooklm-mcp",
      "dist",
      "index.js",
    ),
    sidecarHomeDir: path.join(projectRoot, ".sidecar-home"),
  };
}

export function getScopedNotebooklmDataDir(homeDir, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "notebooklm-mcp");
  }
  if (platform === "win32") {
    return path.join(homeDir, "AppData", "Local", "notebooklm-mcp");
  }
  return path.join(homeDir, ".local", "share", "notebooklm-mcp");
}

export function ensureRequiredSyncConfig(config) {
  if (!config.youtubeChannelUrl && !config.youtubeChannelId) {
    throw new Error(
      "YOUTUBE_CHANNEL_URL 또는 YOUTUBE_CHANNEL_ID 중 하나는 필요합니다.",
    );
  }
}
