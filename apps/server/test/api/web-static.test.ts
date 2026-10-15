import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemDetailFilter } from '../../src/common/problem/problem-detail.filter.js';
import { WEB_EXCLUDE, webStaticModules } from '../../src/web-static.js';

// T4.12 프로덕션 서빙 골격: web dist를 8080에서 제공, SPA 폴백(새로고침 시 index.html), /api·/health 제외
@Controller('api/v1/ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe('web 정적 서빙(ServeStaticModule)', () => {
  // os.tmpdir()(한글 8.3 경로)·점으로 시작하는 폴더(.cache: send의 dotfiles 무시)를 피해 저장소 안 폴더를 쓴다
  const cacheDir = path.resolve('node_modules', 'tf-web-test');
  mkdirSync(cacheDir, { recursive: true });
  const dist = mkdtempSync(path.join(cacheDir, 'tf-web-'));
  let app: INestApplication;
  const SKILL = '---\nname: x\n---\n';
  beforeAll(async () => {
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="app"></div>');
    writeFileSync(path.join(dist, 'app.js'), 'console.log(1)');
    mkdirSync(path.join(dist, 'downloads', 'termflow-table-design'), { recursive: true });
    writeFileSync(path.join(dist, 'downloads', 'termflow-table-design', 'SKILL.md'), SKILL);
    // 로더(Express/Noop)는 DI 시점의 HTTP 어댑터로 정해진다 → Test.createTestingModule이 아니라 NestFactory로 만든다
    @Module({
      imports: [...webStaticModules(dist)],
      controllers: [PingController],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailFilter }],
    })
    class WebModule {}
    app = await NestFactory.create(WebModule, { logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('페이지 경로(/login, /admin/users 새로고침)는 index.html, 정적 파일은 그대로', async () => {
    for (const p of ['/', '/login', '/admin/users', '/projects/RMS/tables/3']) {
      const res = await request(app.getHttpServer()).get(p);
      expect(res.status, p).toBe(200);
      expect(res.text).toContain('<div id="app">');
    }
    const js = await request(app.getHttpServer()).get('/app.js');
    expect(js.text).toBe('console.log(1)');
    // 설계 절차 스킬 파일(T18.14): 웹 빌드가 싣는 원문 그대로 — SPA 폴백이 아니다
    const skill = await request(app.getHttpServer()).get(
      '/downloads/termflow-table-design/SKILL.md',
    );
    expect(skill.status).toBe(200);
    expect(skill.headers['content-type']).toMatch(/markdown/);
    expect(skill.text).toBe(SKILL);
  });

  it('/api/**는 제외: 있는 API는 JSON, 없는 API는 ProblemDetail 404(index.html 아님)', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/ping')).body).toEqual({ ok: true });
    const miss = await request(app.getHttpServer()).get('/api/v1/nope');
    expect(miss.status).toBe(404);
    expect(miss.body).toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('빌드 산출물이 없으면 모듈을 붙이지 않는다, 제외 규칙', () => {
    expect(webStaticModules(path.join(dist, 'none'))).toEqual([]);
    expect(WEB_EXCLUDE.test('/api/v1/x')).toBe(true);
    expect(WEB_EXCLUDE.test('/health')).toBe(true);
    expect(WEB_EXCLUDE.test('/metrics')).toBe(true);
    expect(WEB_EXCLUDE.test('/mcp')).toBe(true);
    expect(WEB_EXCLUDE.test('/apis')).toBe(false);
    expect(WEB_EXCLUDE.test('/admin/users')).toBe(false);
  });
});
