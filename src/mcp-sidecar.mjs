import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getScopedNotebooklmDataDir } from "./config.mjs";

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureSymlinked(targetPath, linkPath) {
  const exists = await pathExists(linkPath);
  if (exists) {
    const stats = await fs.lstat(linkPath);
    if (stats.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath);
      if (path.resolve(path.dirname(linkPath), currentTarget) === path.resolve(targetPath)) {
        return;
      }
      await fs.unlink(linkPath);
    } else {
      throw new Error(
        `sidecar data dir 준비 실패: ${linkPath} 가 symlink 가 아닙니다.`,
      );
    }
  }

  await fs.symlink(targetPath, linkPath, "dir");
}

async function buildSidecarEnv(config) {
  const env = { ...process.env };
  const desired = path.resolve(config.notebooklmDataDir);
  const defaultResolved = path.resolve(config.defaultNotebooklmDataDir);

  if (desired === defaultResolved) {
    return env;
  }

  const shimHome = config.sidecarHomeDir;
  const shimDataDir = getScopedNotebooklmDataDir(shimHome);

  await fs.mkdir(desired, { recursive: true });
  await fs.mkdir(path.dirname(shimDataDir), { recursive: true });
  await ensureSymlinked(desired, shimDataDir);

  env.HOME = shimHome;
  env.USERPROFILE = shimHome;
  if (process.platform === "win32") {
    env.LOCALAPPDATA = path.join(shimHome, "AppData", "Local");
  }

  return env;
}

function parseToolPayload(response) {
  const firstText = response.content?.find((item) => item.type === "text")?.text;
  if (!firstText) {
    throw new Error("MCP tool response 에 JSON text payload 가 없습니다.");
  }
  return JSON.parse(firstText);
}

export class NotebookLmSidecar {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.transport = null;
    this.client = null;
  }

  async connect() {
    if (this.client) return;
    const env = await buildSidecarEnv(this.config);

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.config.mcpServerScript],
      env,
      stderr: "ignore",
    });

    this.client = new Client(
      {
        name: "notebooklm-channel-sync",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );

    await this.client.connect(this.transport);
    this.logger.debug("NotebookLM MCP sidecar connected.");
  }

  async close() {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
    this.transport = null;
  }

  async callToolJson(name, args = {}) {
    await this.connect();
    const response = await this.client.callTool({
      name,
      arguments: args,
    });
    const payload = parseToolPayload(response);
    if (!payload.success) {
      throw new Error(payload.error || `${name} 호출 실패`);
    }
    return payload.data;
  }

  async getHealth() {
    return this.callToolJson("get_health", {});
  }

  async setupAuth() {
    return this.callToolJson("setup_auth", {
      show_browser: true,
    });
  }

  async listNotebooks() {
    const data = await this.callToolJson("list_notebooks", {});
    return data.notebooks || [];
  }

  async addNotebook(args) {
    const data = await this.callToolJson("add_notebook", args);
    return data.notebook;
  }
}
