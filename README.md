# NotebookLM Channel Sync

YouTube 채널의 최신 영상을 NotebookLM 노트북으로 만들고, 각 영상별 Infographic / Slide Deck 공유 링크를 수집하는 standalone CLI입니다.

## Requirements

- Node.js 22+
- Google Chrome
- NotebookLM 사용 가능한 Google 계정

## Usage

### 1. Install

git 에서 다운로드 받습니다.

```
git clone https://github.com/studiojin-dev/notebooklm-channel-sync.git
```

먼저 프로젝트 의존성을 설치하고, 환경 변수 파일(`.env`)을 템플릿에서 복사하여 생성합니다.

```bash
cd notebooklm-channel-sync
npm install
cp .env.example .env
```

### 2. TUI (Interactive Mode)

프로젝트 설정 및 수동 실행을 대화형으로 쉽게 진행하려면 TUI 모드를 사용하세요.
동기화, 상태 확인, 브라우저 인증, 주요 `.env` 설정 변경을 모두 하나의 인터페이스에서 할 수 있습니다.

```bash
npm run tui
```

- **상태 확인 (Status)**: 현재 동기화된 영상과 상태를 확인합니다.
- **인증 (Auth)**: NotebookLM 로그인을 위해 백그라운드 브라우저를 엽니다. (최초 1회 필수)
- **동기화 (Sync)**: 지정된 YouTube 채널의 최신 영상을 NotebookLM으로 가져오고 아티팩트를 자동 생성합니다.
- **설정 (Settings)**: `.env` 파일을 직접 수정하지 않고 TUI 환경에서 직관적으로 환경 변수를 변경할 수 있습니다.

### 3. CLI (Headless / Cron Mode)

단일 명령어 실행이 필요하거나 `cron` 등을 이용해 백그라운드에서 주기적으로 자동화하고 싶을 때는 CLI 명령어를 직접 사용합니다.

- **인증 (최초 1회)**
  ```bash
  npm run auth
  ```
- **상태 확인**
  ```bash
  npm run status
  ```
- **Dry Run (동기화 대상 영상만 미리 보기)**
  ```bash
  node --env-file=.env src/cli.mjs sync --dry-run
  ```
- **실제 동기화 실행**
  ```bash
  npm run sync
  ```
  *(또는 `node --env-file=.env src/cli.mjs sync`)*

## Configuration

주요 환경변수 설정(`.env` 파일 또는 TUI Settings 메뉴에서 변경 가능):

- `YOUTUBE_CHANNEL_URL`: 예) `https://www.youtube.com/@your-channel`
- `YOUTUBE_CHANNEL_ID`: 선택. 알면 넣으면 채널 ID 해석 단계를 건너뜁니다.
- `BACKFILL_COUNT`: 첫 실행 시 최근 몇 개를 처리할지. 기본 `5`
- `MAX_VIDEOS_PER_RUN`: 한 번 실행(Sync)할 때 최대 몇 개의 영상을 처리할지. 기본 `5`
- `HEADLESS`: `true|false`. 보통 `true`, 수동 디버깅은 `false`
- `AUTO_GENERATE_ARTIFACTS`: 자동 생성할 아티팩트 목록 (쉼표 구분)
- `ALLOW_PUBLIC_SHARE`: `true|false`. 기본 `false`
- `VIDEO_DELAY_MIN_MS`, `VIDEO_DELAY_MAX_MS`: 영상 처리 사이 쿨다운. 기본 `60000`~`300000` (1~5분)
- `ARTIFACT_STAGE_DELAY_MS`: 아티팩트 생성 완료 후 다음 작업까지 추가 대기 시간 (기본 15초)

## Cron example

```bash
cd /Volumes/EVO990/openclaw_workspaces/notebooklm-channel-sync && npm run sync >> sync.log 2>&1
```

## Notes

- `ALLOW_PUBLIC_SHARE=true`이면 노트북 공유로 만듭니다. (비추)
- 영상에 captions 가 없거나 업로드 후 72시간이 지나지 않아 NotebookLM import 가 실패하면 `source_missing`으로 기록합니다.
- Studio quota 문제는 `quota_blocked`로 기록합니다.
- auth 가 무작위로 자주 풀립니다. 따라서 cron 에 걸어서 사용하는 경우 sync 가 풀렸는지 주기적으로 확인해야 합니다. 그래서 tui 사용을 추천합니다.
