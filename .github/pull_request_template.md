## 바꾼 것

<!-- 무엇을, 왜. 관련 TODO 항목(T..)·CR 번호 -->

## 확인

- [ ] `pnpm lint` · `pnpm typecheck`
- [ ] 고친 범위의 `pnpm test` · `pnpm test:db -- <필터>`
- [ ] 새 REST 라우트가 있으면 `apps/server/src/mcp/tool-specs.ts`에 도구 이름·설명(또는 제외 사유)
- [ ] 화면·동작이 바뀌면 `docs/사용자_가이드.md`(필요하면 `docs/img/screens/`)
- [ ] 설계 수준 변경이면 `docs/CR-{nn}_*.md`
- [ ] 판을 올리면 `package.json` · `docker-compose.yml` · `docs/릴리스_노트_v<판>.md` · `CHANGELOG.md` · `site/src/data/releases.ts`, `bash scripts/release-check.sh`
