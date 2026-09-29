/**
 * 성능 판정 기준(CR-05 C1). `pnpm test:db -- <파일 필터>`(격리 실행)면 설계 기준(엄격), 전체 실행(`pnpm test:db`, 17개 파일이
 * 한 컨테이너에서 동시에 승계 러너·복사·2만 행 적재를 돌림)이면 CPU 경합을 감안한 완화 기준을 쓴다 — 전체 실행에서도 회귀(수 배 느려짐)는
 * 잡되, 부하에 따라 흔들리는 실패는 없앤다. 격리 여부는 `scripts/run-vitest.mjs`가 `TF_TEST_ISOLATED`로 알려 준다.
 */
export const ISOLATED = process.env['TF_TEST_ISOLATED'] === '1';

export function perfLimit(strictMs: number, loadedMs: number): number {
  return ISOLATED ? strictMs : loadedMs;
}
