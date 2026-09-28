#!/usr/bin/env node
// 서버 개발 실행(`pnpm dev`): `nest build --watch`(tsc, emitDecoratorMetadata) + `node --watch dist/main.js`.
// `nest start --watch`는 Windows에서 재시작 때 cmd.exe 트리를 taskkill /T로 죽이다가 경합으로 실패해
// watch 프로세스 전체가 종료된다(Nest CLI 12.0.7, 단계 2 발견). 재시작은 Node 내장 --watch에 맡긴다.
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nestBin = path.join(root, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const mainJs = path.join(root, 'dist', 'main.js');

const children = [];
const run = (args) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    // 한쪽이 끝나면 전체 종료(Ctrl+C 또는 오류)
    for (const c of children) if (c !== child && c.exitCode === null) c.kill();
    process.exitCode = code ?? 0;
  });
  return child;
};

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
run([nestBin, 'build', '--watch', '--preserveWatchOutput']);

// 첫 빌드(deleteOutDir 후 재생성)를 기다렸다가 서버를 띄운다
const timer = setInterval(() => {
  if (existsSync(mainJs)) {
    clearInterval(timer);
    run(['--enable-source-maps', '--watch', '--watch-preserve-output', mainJs]);
  }
}, 500);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    for (const c of children) if (c.exitCode === null) c.kill();
  });
}
