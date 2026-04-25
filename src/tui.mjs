import fs from 'node:fs/promises';
import path from 'node:path';
import { intro, outro, select, confirm, spinner, note, cancel, isCancel, text, multiselect } from '@clack/prompts';
import pc from 'picocolors';
import { runAuth, runStatus, runSync } from './cli.mjs';
import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';

async function updateEnvFile(updates) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  try {
    envContent = await fs.readFile(envPath, 'utf-8');
  } catch (err) {
    // Ignore if not exists
  }
  
  const lines = envContent.split('\n');
  const newLines = [];
  const updatedKeys = new Set();
  
  for (const line of lines) {
    const match = line.match(/^([^#\s=]+)=/);
    if (match) {
      const key = match[1];
      if (updates[key] !== undefined) {
        newLines.push(`${key}=${updates[key]}`);
        updatedKeys.add(key);
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }
  
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${val}`);
    }
  }
  
  await fs.writeFile(envPath, newLines.join('\n'));

  // process.env 도 즉시 갱신하여 loadConfig 가 최신 값을 반환하도록 함
  for (const [key, val] of Object.entries(updates)) {
    process.env[key] = String(val);
  }
}

async function main() {
  intro(pc.bgCyan(pc.black(' NotebookLM Channel Sync TUI ')));

  let config;
  const logger = createLogger({ level: 'info' });

  while (true) {
    config = loadConfig(process.env);
    const action = await select({
      message: '무엇을 하시겠습니까?',
      options: [
        { value: 'status', label: '📊 상태 확인 (Status)', hint: '현재 동기화 상태 및 대기열 확인' },
        { value: 'sync', label: '🔄 동기화 (Sync)', hint: '최신 영상 가져오기 및 NotebookLM 동기화' },
        { value: 'auth', label: '🔐 인증 (Auth)', hint: 'NotebookLM 인증 브라우저 열기' },
        { value: 'settings', label: '⚙️ 설정 (Settings)', hint: '동기화 및 아티팩트 설정 변경' },
        { value: 'exit', label: '❌ 종료' }
      ]
    });

    if (isCancel(action) || action === 'exit') {
      outro('TUI를 종료합니다. 안녕히 가세요!');
      process.exit(0);
    }

    if (action === 'status') {
      const s = spinner();
      s.start('상태 확인 중...');
      try {
        const result = await runStatus(config, logger);
        s.stop('상태 확인 완료');
        
        let msg = `채널: ${pc.green(result.channel?.title || '알 수 없음')}\n`;
        msg += `인증 상태: ${result.authenticated ? pc.green('✅ 완료') : pc.red('❌ 미인증')}\n`;
        msg += `추적 중인 영상 수: ${pc.cyan(result.trackedVideos || 0)} 개\n`;
        msg += `최근 실행: ${result.lastRunAt || '없음'}\n\n`;
        msg += `[상태별 요약]\n`;
        if (result.statuses && Object.keys(result.statuses).length > 0) {
          for (const [status, count] of Object.entries(result.statuses)) {
             msg += `- ${status}: ${count}개\n`;
          }
        } else {
          msg += '- 상태 없음\n';
        }
        
        note(msg, 'Status Summary');
      } catch (err) {
        s.stop('오류 발생');
        console.error(pc.red(err.message));
      }
    } else if (action === 'auth') {
      const s = spinner();
      s.start('인증 프로세스 준비 중...');
      try {
        const result = await runAuth(config, logger);
        s.stop('인증 완료');
        note(`상태: ${result.status}\n계정: ${result.account || '알 수 없음'}`, 'Auth Result');
      } catch (err) {
        s.stop('오류 발생');
        console.error(pc.red(err.message));
      }
    } else if (action === 'sync') {
      const dryRun = await confirm({
        message: '실제 동기화 대신 대상 영상 목록만 확인하시겠습니까? (Dry Run)',
        initialValue: true
      });
      
      if (isCancel(dryRun)) {
        continue;
      }

      const s = spinner();
      s.start(dryRun ? '동기화 대상 조회 중...' : '동기화 진행 중 (시간이 다소 소요됩니다)...');
      
      try {
        const result = await runSync(config, logger, { dryRun });
        s.stop('완료');
        
        if (dryRun) {
          let msg = `처리 예정 영상 (${result.pendingVideos?.length || 0}개):\n`;
          if (result.pendingVideos && result.pendingVideos.length > 0) {
            result.pendingVideos.forEach((v, i) => {
              msg += `${i + 1}. [${v.videoId}] ${v.title}\n`;
            });
          } else {
            msg += '새로운 영상이 없습니다.\n';
          }
          note(msg, 'Dry Run Result');
        } else {
          note(`처리된 영상 수: ${result.processed}\n최대 허용 처리 수: ${result.maxVideosPerRun}`, 'Sync Result');
        }
      } catch (err) {
        s.stop('오류 발생');
        console.error(pc.red(err.message));
      }
    } else if (action === 'settings') {
      const newBackfillCount = await text({
        message: '초기 동기화 수 (BACKFILL_COUNT, 기본값 5)',
        initialValue: String(config.backfillCount),
        validate(value) {
          if (isNaN(parseInt(value, 10))) return '숫자를 입력해주세요';
        }
      });
      if (isCancel(newBackfillCount)) continue;

      const newMaxVideosPerRun = await text({
        message: '한 번에 동기화할 최대 영상 수 (MAX_VIDEOS_PER_RUN, 기본값 5)',
        initialValue: String(config.maxVideosPerRun),
        validate(value) {
          if (isNaN(parseInt(value, 10))) return '숫자를 입력해주세요';
        }
      });
      if (isCancel(newMaxVideosPerRun)) continue;

      const newHeadless = await confirm({
        message: '브라우저를 백그라운드에서 실행하시겠습니까? (HEADLESS)',
        initialValue: config.headless
      });
      if (isCancel(newHeadless)) continue;

      const newAllowPublicShare = await confirm({
        message: '퍼블릭 공유 링크 생성을 허용하시겠습니까? (ALLOW_PUBLIC_SHARE)',
        initialValue: config.allowPublicShare
      });
      if (isCancel(newAllowPublicShare)) continue;

      const newArtifacts = await multiselect({
        message: '노트북 추가 후 자동으로 생성할 아티팩트를 선택하세요.',
        options: [
          { value: '마인드맵', label: '마인드맵 (Mind Map)' },
          { value: '플래시카드', label: '플래시카드 (Flashcards)' },
          { value: '데이터 표', label: '데이터 표 (Data Table)' },
          { value: '슬라이드', label: '슬라이드 (Slide Deck)' },
          { value: '인포그래픽', label: '인포그래픽 (Infographic)' },
          { value: 'ai 오디오', label: 'AI 오디오 (Audio Overview)' }
        ],
        initialValues: config.autoGenerateArtifacts || ['슬라이드'],
        required: false
      });
      if (isCancel(newArtifacts)) continue;

      const s = spinner();
      s.start('설정 저장 중...');
      
      const updates = {
        BACKFILL_COUNT: newBackfillCount,
        MAX_VIDEOS_PER_RUN: newMaxVideosPerRun,
        HEADLESS: newHeadless,
        ALLOW_PUBLIC_SHARE: newAllowPublicShare,
        AUTO_GENERATE_ARTIFACTS: newArtifacts.join(',')
      };

      try {
        await updateEnvFile(updates);
        // 재로드된 설정 반영
        config = loadConfig(process.env);
        s.stop('저장 완료');
        note('설정이 .env 파일에 저장되었습니다.\n변경된 설정을 반영하려면 TUI를 종료 후 다시 실행해 주세요.', 'Settings Saved');
      } catch (err) {
        s.stop('오류 발생');
        console.error(pc.red(`저장 실패: ${err.message}`));
      }
    }
  }
}

main().catch((error) => {
  cancel(pc.red(`예기치 않은 오류 발생: ${error.message}`));
  process.exit(1);
});
