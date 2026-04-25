import { chromium } from "patchright";
import { ARTIFACT_STATUS } from "./state-machine.mjs";

function sanitizeNotebookName(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstVisibleLocator(candidates) {
  for (const locator of candidates) {
    try {
      const count = await locator.count();
      if (count) {
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          const visible = await candidate.isVisible();
          if (visible) return candidate;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function clickByText(page, texts) {
  const candidates = [];
  for (const text of texts) {
    const pattern = text instanceof RegExp ? text : new RegExp(text, "i");
    candidates.push(page.getByRole("button", { name: pattern }));
    candidates.push(page.getByRole("link", { name: pattern }));
    candidates.push(page.getByLabel(pattern));
    candidates.push(page.getByText(pattern));
  }
  const locator = await firstVisibleLocator(candidates);
  if (!locator) return false;
  await locator.click();
  return true;
}

async function waitForAnyText(page, patterns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const locator = page.getByText(pattern);
      try {
        if (await locator.count()) {
          if (await locator.first().isVisible()) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }
    await delay(500);
  }
  return false;
}

async function tryReadVisibleText(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.getByText(pattern);
    try {
      if (await locator.count()) {
        const value = await locator.first().textContent();
        if (value) return value;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function summarizeVisibleButtons(page, limit = 20) {
  return page.evaluate((max) => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("button"))
      .map((button) => norm(button.innerText || button.textContent || "") || norm(button.getAttribute("aria-label") || ""))
      .filter(Boolean)
      .slice(0, max);
  }, limit);
}

async function summarizeOverlay(page, limit = 20) {
  return page.evaluate((max) => {
    const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector(".cdk-overlay-container");
    if (!root) {
      return { text: "", buttons: [] };
    }
    const buttons = Array.from(root.querySelectorAll("button"))
      .map((button) => norm(button.innerText || button.textContent || "") || norm(button.getAttribute("aria-label") || ""))
      .filter(Boolean)
      .slice(0, max);
    return {
      text: norm(root.innerText).slice(0, 2000),
      buttons,
    };
  }, limit);
}

async function backdropCount(page) {
  return page.locator(".cdk-overlay-backdrop").count();
}

async function readNotebookSourceCount(page) {
  return page.evaluate(() => {
    const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const koreanMatches = [...text.matchAll(/소스\s*(\d+)개/g)].map((match) =>
      Number.parseInt(match[1], 10),
    );
    const englishMatches = [...text.matchAll(/(\d+)\s+sources?/gi)].map((match) =>
      Number.parseInt(match[1], 10),
    );
    const values = [...koreanMatches, ...englishMatches].filter((value) =>
      Number.isFinite(value),
    );
    if (values.length === 0) {
      return null;
    }
    return Math.max(...values);
  });
}

function inferSourceFailure(errorText) {
  if (!errorText) return null;
  const normalized = errorText.toLowerCase();
  if (
    normalized.includes("captions") ||
    normalized.includes("less than 72 hours") ||
    normalized.includes("doesn't have") ||
    normalized.includes("invalid youtube") ||
    normalized.includes("video language")
  ) {
    return ARTIFACT_STATUS.SOURCE_MISSING;
  }
  if (normalized.includes("limit") || normalized.includes("quota")) {
    return ARTIFACT_STATUS.QUOTA_BLOCKED;
  }
  return ARTIFACT_STATUS.FAILED;
}

export class NotebookLmStudioSession {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.context = await chromium.launchPersistentContext(
      this.config.chromeProfileDir,
      {
        headless: this.config.headless,
        channel: "chrome",
        viewport: { width: 1440, height: 1024 },
        locale: "en-US",
        timezoneId: "Asia/Seoul",
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      },
    );
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto("https://notebooklm.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: this.config.browserTimeoutMs,
    });
    await this.ensureAuthenticated();
  }

  async close() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }

  async ensureAuthenticated() {
    if (this.page.url().includes("accounts.google.com")) {
      throw new Error("NotebookLM authentication required. `auth` 명령을 먼저 실행하세요.");
    }
    const signedOut = await waitForAnyText(
      this.page,
      [/sign in/i, /로그인/i],
      3000,
    );
    if (signedOut && this.page.url().includes("accounts.google.com")) {
      throw new Error("NotebookLM authentication required. `auth` 명령을 먼저 실행하세요.");
    }
  }

  async processVideo(video) {
    await this.goHome();
    const notebookUrl = await this.createNotebookForVideo(video);
    await this.waitForStageSettle("indexing", this.config.indexingSettleMs);
    const artifacts = {};
    const mapping = {
      "마인드맵": [/mind map/i, /마인드맵/i],
      "플래시카드": [/flashcard/i, /플래시카드/i],
      "데이터 표": [/data table/i, /데이터 표/i, /표/i],
      "슬라이드": [/slide deck/i, /slides/i, /슬라이드/i],
      "인포그래픽": [/infographic/i, /인포그래픽/i],
      "ai 오디오": [/audio overview/i, /오디오/i, /deep dive/i],
      "Slide Deck": [/slide deck/i, /slides/i, /슬라이드/i],
      "Infographic": [/infographic/i, /인포그래픽/i]
    };

    if (this.config.autoGenerateArtifacts && this.config.autoGenerateArtifacts.length > 0) {
      for (const artifactName of this.config.autoGenerateArtifacts) {
        const patterns = mapping[artifactName] || mapping["슬라이드"];
        const result = await this.generateArtifact(artifactName, patterns);
        artifacts[artifactName] = result;
        await this.waitForStageSettle(artifactName, this.config.artifactStageDelayMs);
      }
    }

    return {
      notebookUrl,
      artifacts,
    };
  }

  async goHome() {
    await this.page.goto("https://notebooklm.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: this.config.browserTimeoutMs,
    });
    await this.ensureAuthenticated();
  }

  async createNotebookForVideo(video) {
    this.logger.info(`Creating notebook for ${video.videoId}`);

    const newNotebookClicked = await clickByText(this.page, [
      /new notebook/i,
      /create/i,
      /\+ new/i,
      /새 노트 만들기/i,
      /새로 만들기/i,
      /노트북 만들기/i,
    ]);

    if (!newNotebookClicked) {
      throw new Error("NotebookLM home 에서 새 노트북 버튼을 찾지 못했습니다.");
    }

    await this.page.waitForURL(/\/notebook\//, {
      timeout: this.config.browserTimeoutMs,
    });

    await this.tryRenameNotebook(video.title);
    await this.addYoutubeSource(video.videoUrl);
    await this.waitForSourceReady();

    return this.page.url();
  }

  async tryRenameNotebook(title) {
    const notebookName = sanitizeNotebookName(title);
    const editableCandidates = [
      this.page.locator("[contenteditable='true']").first(),
      this.page.getByRole("textbox").first(),
    ];

    const editable = await firstVisibleLocator(editableCandidates);
    if (!editable) {
      return;
    }

    try {
      await editable.click({ clickCount: 3 });
      await editable.fill?.("");
    } catch {
      // Some contenteditable nodes do not support fill.
    }

    try {
      await editable.press("Meta+A");
    } catch {}

    try {
      await editable.type(notebookName, { delay: 20 });
      await editable.press("Enter");
    } catch {
      // Best effort only.
    }
  }

  async addYoutubeSource(videoUrl) {
    const entryPoint = await this.waitForSourceEntryPoint();
    if (entryPoint === "add-button") {
      const addClicked = await clickByText(this.page, [
        /add source/i,
        /sources/i,
        /source/i,
        /소스 추가/i,
        /출처 추가/i,
      ]);
      if (!addClicked) {
        const visibleButtons = await summarizeVisibleButtons(this.page);
        throw new Error(
          `Add source 버튼을 찾지 못했습니다. visibleButtons=${visibleButtons.join(" | ")}`,
        );
      }
      await delay(750);
    }

    const websiteClicked = await this.waitAndClickWebsiteOption();
    if (!websiteClicked) {
      const visibleButtons = await summarizeVisibleButtons(this.page);
      throw new Error(
        `웹사이트 source 옵션을 찾지 못했습니다. visibleButtons=${visibleButtons.join(" | ")}`,
      );
    }

    const dialogReady = await waitForAnyText(
      this.page,
      [/youtube url/i, /웹사이트 및 youtube url/i, /url notebooklm/i, /링크를 붙여넣으세요/i],
      15000,
    );
    if (!dialogReady) {
      const overlay = await summarizeOverlay(this.page);
      throw new Error(
        `웹사이트 URL overlay가 열리지 않았습니다. overlayText=${overlay.text} buttons=${overlay.buttons.join(" | ")}`,
      );
    }

    const filled = await this.fillSourceUrlOverlay(videoUrl);
    if (!filled) {
      const overlay = await summarizeOverlay(this.page);
      throw new Error(
        `소스 URL 입력 필드를 찾지 못했습니다. overlayText=${overlay.text} buttons=${overlay.buttons.join(" | ")}`,
      );
    }

    const importClicked = await this.waitAndClickOverlayInsert();
    if (!importClicked) {
      const overlay = await summarizeOverlay(this.page);
      throw new Error(
        `삽입 버튼을 활성화하지 못했습니다. overlayText=${overlay.text} buttons=${overlay.buttons.join(" | ")}`,
      );
    }
  }

  async fillSourceUrlOverlay(videoUrl) {
    return this.page.evaluate((url) => {
      const textarea = document.querySelector(
        "textarea[aria-label*='URL'], textarea[placeholder*='링크'], textarea[placeholder*='Paste']",
      );
      if (!textarea) return false;

      textarea.focus();
      textarea.value = url;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, videoUrl);
  }

  async waitAndClickOverlayInsert() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const insertButton = await firstVisibleLocator([
        this.page.getByRole("button", { name: /insert|삽입/i }),
        this.page.getByText(/insert|삽입/i),
      ]);

      if (insertButton) {
        const text = ((await insertButton.textContent()) || "").trim();
        const aria = ((await insertButton.getAttribute("aria-label")) || "").trim();
        const buttonLabel = `${text} ${aria}`.trim();
        const isInsert =
          /insert|삽입/i.test(buttonLabel) ||
          /insert|삽입/i.test(text) ||
          /insert|삽입/i.test(aria);

        if (isInsert && !(await insertButton.isDisabled())) {
          await insertButton.click();
          return true;
        }
      }

      await delay(300);
    }
    return false;
  }

  async waitForSourceEntryPoint() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const websiteButtons = this.page
        .locator("button")
        .filter({ hasText: /웹사이트|website/i });
      if ((await websiteButtons.count()) > 0) {
        return "direct-options";
      }

      const addButtons = this.page
        .locator("button")
        .filter({ hasText: /소스 추가|출처 추가|add source|sources|source/i });
      if ((await addButtons.count()) > 0) {
        return "add-button";
      }

      await delay(500);
    }

    const visibleButtons = await summarizeVisibleButtons(this.page);
    throw new Error(
      `source picker 진입점을 찾지 못했습니다. visibleButtons=${visibleButtons.join(" | ")}`,
    );
  }

  async waitAndClickWebsiteOption() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const websiteButtons = this.page
        .locator("button")
        .filter({ hasText: /웹사이트|website/i });
      if ((await websiteButtons.count()) > 0) {
        await websiteButtons.last().click();
        return true;
      }
      await delay(500);
    }
    return false;
  }

  async waitForSourceReady() {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const sourceCount = await readNotebookSourceCount(this.page);
      const failureText = await tryReadVisibleText(this.page, [
        /captions/i,
        /less than 72 hours/i,
        /unsafe/i,
        /invalid/i,
        /quota/i,
        /limit/i,
      ]);
      if (failureText) {
        const status = inferSourceFailure(failureText);
        const error = new Error(failureText);
        error.stageStatus = status;
        throw error;
      }

      const processingText = await tryReadVisibleText(this.page, [
        /importing/i,
        /processing/i,
        /analyzing/i,
        /loading/i,
      ]);

      const studioReady = await waitForAnyText(
        this.page,
        [/infographic/i, /slide deck/i, /slides/i, /인포그래픽/i, /슬라이드 자료/i],
        1500,
      );

      if (
        sourceCount !== null &&
        sourceCount > 0 &&
        studioReady &&
        !processingText &&
        (await backdropCount(this.page)) === 0
      ) {
        return;
      }

      await delay(1500);
    }

    const sourceCount = await readNotebookSourceCount(this.page);
    throw new Error(`소스 인덱싱 대기 시간이 초과되었습니다. sourceCount=${sourceCount}`);
  }

  async generateArtifact(kind, triggerLabels) {
    this.logger.info(`Generating ${kind}`);
    await this.dismissBlockingOverlay();
    let opened = await this.clickArtifactButton(triggerLabels);
    if (!opened) {
      opened = await clickByText(this.page, triggerLabels);
    }
    if (!opened) {
      return {
        status: ARTIFACT_STATUS.FAILED,
        link: null,
        error: `${kind} 패널을 찾지 못했습니다.`,
      };
    }

    return this.waitForArtifactReady(kind, triggerLabels);
  }

  async clickArtifactButton(triggerLabels) {
    const containers = this.page.locator('.create-artifact-button-container');
    const count = await containers.count();
    for (let i = 0; i < count; i++) {
      const container = containers.nth(i);
      const ariaLabel = (await container.getAttribute('aria-label')) || '';
      const textContent = (await container.textContent()) || '';
      
      for (const pattern of triggerLabels) {
        if (pattern.test(ariaLabel) || pattern.test(textContent)) {
          if (await container.isVisible()) {
            await container.click({ force: true });
            return true;
          }
        }
      }
    }
    return false;
  }

  async waitForArtifactReady(kind, triggerLabels) {
    const deadline = Date.now() + 240000;
    let requested = false;
    let hasSeenGenerating = false;
    let loopsWithoutGenerating = 0;

    while (Date.now() < deadline) {
      const quotaText = await tryReadVisibleText(this.page, [/quota/i, /limit/i, /한도/i]);
      if (quotaText) {
        await this.dismissBlockingOverlay();
        return {
          status: ARTIFACT_STATUS.QUOTA_BLOCKED,
          link: null,
          error: quotaText,
        };
      }

      const failureText = await tryReadVisibleText(this.page, [
        /couldn/i,
        /failed/i,
        /try again/i,
        /실패/i,
        /오류/i
      ]);
      if (failureText) {
        await this.dismissBlockingOverlay();
        return {
          status: ARTIFACT_STATUS.FAILED,
          link: null,
          error: failureText,
        };
      }

      const overlayOpen = (await backdropCount(this.page)) > 0;
      const generatingTextMatch = await tryReadVisibleText(this.page, [
        /generating/i,
        /creating/i,
        /working/i,
        /생성 중/i,
        /만드는 중/i,
        /작성/i,
        /준비/i
      ]);
      
      const generating = !!generatingTextMatch;

      if (generating) {
        this.logger.info(`Detected 'Generating...' state. Waiting 3 seconds before proceeding.`);
        await delay(3000);
        return {
          status: ARTIFACT_STATUS.GENERATED,
          link: null,
          error: null,
        };
      } else {
        loopsWithoutGenerating++;
      }

      if (!requested) {
        const requestClicked = await this.triggerArtifactGeneration();
        if (requestClicked) {
          requested = true;
        } else if (loopsWithoutGenerating > 2) {
          // No 'Generate' button found after a few loops. It likely started generating directly.
          requested = true;
        }
      }

      if (requested && !overlayOpen && !generating) {
        // If we never saw it generating but 10 seconds passed, assume it's done or started implicitly.
        if (loopsWithoutGenerating > 5) {
          return {
            status: ARTIFACT_STATUS.GENERATED,
            link: null,
            error: null,
          };
        }
      }

      await delay(2000);
      
      // If nothing is happening, try clicking the trigger button again
      if (!overlayOpen && !requested && !hasSeenGenerating && loopsWithoutGenerating > 3) {
        await clickByText(this.page, triggerLabels);
      }
    }

    await this.dismissBlockingOverlay();
    return {
      status: ARTIFACT_STATUS.FAILED,
      link: null,
      error: `${kind} 생성 대기 시간이 초과되었습니다.`,
    };
  }

  async triggerArtifactGeneration() {
    const clicked = await clickByText(this.page, [
      /generate/i,
      /create/i,
      /생성/i,
      /만들기/i,
    ]);
    return clicked;
  }

  async dismissBlockingOverlay() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const count = await backdropCount(this.page);
      if (count === 0) {
        return;
      }

      const closeClicked = await clickByText(this.page, [
        /close/i,
        /done/i,
        /닫기/i,
        /완료/i,
      ]);
      if (!closeClicked) {
        try {
          await this.page.keyboard.press("Escape");
        } catch {
          // ignore
        }
      }

      await delay(500);
    }
  }

  async waitForStageSettle(label, durationMs) {
    const waitMs = Math.max(0, durationMs || 0);
    if (waitMs === 0) {
      return;
    }
    await this.dismissBlockingOverlay();
    this.logger.info(
      `Waiting ${Math.round(waitMs / 1000)}s for ${label} stabilization`,
    );
    await delay(waitMs);
    await this.dismissBlockingOverlay();
  }
}
