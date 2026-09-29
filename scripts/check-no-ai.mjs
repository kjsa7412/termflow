#!/usr/bin/env node
// pnpm check:no-ai (T0.13, 설계서 §1.2 AI 기능 미포함)
// 추적 파일 + 추적 전(ignore 제외) 파일에서 AI 관련 문자열을 찾아 1건이라도 있으면 실패한다.
// 제외: docs(설계 문서), seed/original·seed/PROFILE_original.md(원본 보존·프로파일 기록), .claude·루트 규칙 문서(개발 도구 설정), pnpm-lock.yaml(서드파티 이름),
//       이 스크립트 자신(검색 패턴을 담고 있음).
import { spawnSync } from 'node:child_process';

const PATTERN = 'chat|claude|openai|llm';
const EXCLUDES = [
  ':!docs',
  ':!seed/original',
  // 원본 dump 프로파일 기록: legacy 테이블명(R12 삭제 대상) 나열만 걸린다.
  ':!seed/PROFILE_original.md',
  ':!.claude',
  // 에이전트 공통 작업 규칙(커밋 서명 줄·금지 항목 설명에 도구 이름이 들어간다). .claude와 같은 개발 도구 설정 취급
  ':!CLAUDE.md',
  ':!pnpm-lock.yaml',
  ':!scripts/check-no-ai.mjs',
];

const result = spawnSync(
  'git',
  ['grep', '--untracked', '-n', '-I', '-i', '-E', PATTERN, '--', '.', ...EXCLUDES],
  { encoding: 'utf8' },
);

if (result.error) {
  console.error(`[check:no-ai] git 실행 실패: ${result.error.message}`);
  process.exit(2);
}

// git grep: 0 = 일치 있음, 1 = 일치 없음, 그 외 = 오류
if (result.status === 1) {
  console.log('[check:no-ai] OK — AI 관련 문자열 0건');
  process.exit(0);
}
if (result.status === 0) {
  const lines = result.stdout.trimEnd().split('\n');
  console.error(`[check:no-ai] 실패 — AI 관련 문자열 ${lines.length}건(§1.2 AI 기능 금지):`);
  console.error(lines.join('\n'));
  process.exit(1);
}
console.error(`[check:no-ai] git grep 오류(종료 코드 ${result.status}): ${result.stderr}`);
process.exit(2);
