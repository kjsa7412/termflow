import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_FILE_ROLL, loggerParams } from '../../src/common/logging/logger.config.js';

// T11.5 로그 운영(§12.3): prod 파일 로그가 자정에 새 파일로 넘어가고 30개만 남는지 — pino-roll을 실제 옵션으로 직접 구동한다.
interface RollStream {
  write(s: string): boolean;
  flushSync(): void;
  end(): void;
  once(event: string, cb: () => void): void;
}
type PinoRoll = (opts: Record<string, unknown>) => Promise<RollStream>;
const pinoRoll = createRequire(import.meta.url)('pino-roll') as PinoRoll;

let dir: string;
let stream: RollStream | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tf-logroll-'));
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  if (stream) {
    const s = stream;
    await new Promise<void>((r) => {
      s.once('close', r);
      s.end();
    });
    stream = undefined;
  }
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function open(): Promise<RollStream> {
  const s = await pinoRoll({ ...LOG_FILE_ROLL, file: path.join(dir, 'termflow.log') });
  await new Promise<void>((r) => s.once('ready', r));
  return s;
}

describe('pino-roll 일 단위 롤링(T11.5)', () => {
  it('prod 설정이 LOG_FILE_ROLL(daily·30개·다른 프로세스 파일 포함 정리)을 쓴다', () => {
    const params = loggerParams({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    const http = params.pinoHttp as {
      transport: { targets: { target: string; options: unknown }[] };
    };
    const roll = http.transport.targets.find((t) => t.target === 'pino-roll');
    expect(roll?.options).toEqual(LOG_FILE_ROLL);
    expect(LOG_FILE_ROLL).toMatchObject({
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      limit: { count: 30, removeOtherLogFiles: true },
    });
  });

  it('날짜가 바뀌면 새 파일(termflow.YYYY-MM-DD.1.log)에 쓴다', async () => {
    vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 50));
    stream = await open();
    stream.write('before-midnight\n');
    stream.flushSync();
    const day1 = path.join(dir, 'termflow.2026-09-29.1.log');
    const day2 = path.join(dir, 'termflow.2026-09-30.1.log');
    expect(existsSync(day1)).toBe(true);

    vi.advanceTimersByTime(11_000); // 00:00:01 — 롤 타이머 발화
    await vi.waitFor(() => expect(existsSync(day2)).toBe(true), { timeout: 5_000 });
    stream.write('after-midnight\n');
    stream.flushSync();

    expect(readFileSync(day1, 'utf8')).toBe('before-midnight\n');
    expect(readFileSync(day2, 'utf8')).toBe('after-midnight\n');
  });

  it('롤 시 오래된 파일을 지워 30개 안팎만 남긴다(이전 프로세스가 만든 파일 포함)', async () => {
    // 이전 기동이 남긴 35일치(2026-08-01 ~ 2026-09-04)
    const old: string[] = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date(2026, 7, 1 + i);
      const name = `termflow.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.1.log`;
      writeFileSync(path.join(dir, name), 'old\n');
      old.push(name);
    }
    vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 50));
    stream = await open();
    const s = stream;
    const cleaned = new Promise<void>((r) => s.once('cleanup-complete', r));
    vi.advanceTimersByTime(11_000);
    await cleaned;
    await vi.waitFor(
      () => expect(existsSync(path.join(dir, 'termflow.2026-09-30.1.log'))).toBe(true),
      { timeout: 5_000 },
    );

    const left = readdirSync(dir).filter((f) => f.startsWith('termflow.'));
    // 정리 시점에 새 파일이 아직 열리지 않았을 수 있어 30 또는 31(다음 롤에서 30으로 수렴)
    expect(left.length).toBeGreaterThanOrEqual(30);
    expect(left.length).toBeLessThanOrEqual(31);
    expect(left).not.toContain(old[0]); // 가장 오래된 파일부터 삭제
    expect(left).toContain('termflow.2026-09-30.1.log');
    expect(left).toContain(old[34]);
  });
});
