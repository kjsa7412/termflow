# syntax=docker/dockerfile:1
# TermFlow 단일 이미지 termflow-app(설계서 §2.5.8, §12.6, T11.1). 빌드: docker build -t termflow-app:1.1.0 .
#
# 이미지 안 배치는 저장소 구조를 그대로 따른다(CR-11a C1). 서버 코드가 자기 위치 기준 상대 경로로 찾는 것:
#   /app/apps/server/dist        ← main.js, migration/seed.js
#   /app/apps/server/drizzle     ← db/migrate.ts  '../../drizzle'
#   /app/apps/server/resources   ← ddl/resources.ts '../../resources'
#   /app/apps/web/dist           ← web-static.ts '../../web/dist'(SPA 폴백. 경로에 점(.) 폴더가 없어야 한다, CR-03 C19)
#   /app/logs, /app/migration/report ← 작업 디렉터리 /app 기준(pino-roll 'logs/…', 러너 리포트)
# 승계 러너: docker compose run --rm app node apps/server/dist/migration/seed.js --steps=…

ARG NODE_IMAGE=node:22-alpine

# ---------- 1단계: 설치·빌드 ----------
FROM ${NODE_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src

# 의존성 내려받기 층(잠금 파일이 바뀔 때만 다시 받는다). packageManager(pnpm 버전)는 루트 package.json에서 읽는다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# 소스 복사 → 오프라인 설치(onlyBuiltDependencies: bcrypt는 linux-x64 musl prebuild를 쓴다) → 빌드(shared → web → server)
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm -r build

# 서버 프로덕션 의존성만 격리(K10). pnpm 10 deploy는 inject-workspace-packages=true(잠금 파일 기준) 또는 --legacy(재해석)다.
# --legacy는 잠금 파일 없이 범위를 다시 풀어 버전이 바뀔 수 있고 네트워크 메타데이터가 필요하므로(실측 150~290초),
# 이 명령에서만 주입 모드를 켜 잠금 파일 버전 그대로·오프라인으로 만든다(CR-11a C2). 저장소 설정·잠금 파일은 그대로.
RUN pnpm --config.inject-workspace-packages=true --offline --filter @termflow/server deploy --prod /out/server \
 && rm -rf /out/server/test /out/server/scripts /out/server/src /out/server/*.config.ts \
      /out/server/tsconfig*.json /out/server/nest-cli.json

# ---------- 2단계: 실행 ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    PORT=8080
WORKDIR /app

# 실행에 쓰지 않는 npm·corepack·yarn 제거(베이스 층이라 이미지 크기는 그대로, 컨테이너 안 실행 표면·취약점 스캔 대상 축소)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build --chown=node:node /out/server ./apps/server
COPY --from=build --chown=node:node /src/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /src/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=node:node /src/apps/server/resources ./apps/server/resources
COPY --from=build --chown=node:node /src/apps/web/dist ./apps/web/dist

# 쓰기 위치: 로그(볼륨)·승계 리포트(볼륨)·승계 작업 파일(컨테이너 임시)
RUN mkdir -p logs migration/report migration/work \
 && chown -R node:node logs migration

USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
