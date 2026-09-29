import { eq } from 'drizzle-orm';
import { MIGRATION_AUDIT } from '../../common/audit/audit.js';
import { tfUser } from '../../db/schema.js';
import type { CopyPlan, CopySource } from '../../project/copy/copy-plan.js';
import { executeCopy } from '../../project/copy/project-copy.service.js';
import { findProjectId, RMS, StepFailure, stdv1Id, type StepDef } from '../context.js';

export const COPY_TO_RMS_HEADER = [
  'item',
  'source_kind',
  'source_key',
  'source_cnt',
  'copied_cnt',
  'skipped_cnt',
  'flagged_cnt',
  'elapsed_ms',
] as const;

/**
 * step 9 COPY_TO_RMS(T5.9, 설계서 §11.1): 복사 엔진(§4.4)을 그대로 호출해 "연구관리시스템(이관)"(키 RMS)을 만든다.
 * 원본 = STDV1 전 항목, 업무구분 6개 전부, approvedOnly=false(검토 도메인 293 등 review 값 그대로 복사).
 * 프로젝트 관리자 = `--rms-admin`(기본 부트스트랩 관리자). 사용자가 없으면 명확한 오류로 중단한다.
 * 엔진이 자체 repeatable read 트랜잭션을 여므로 러너 트랜잭션을 쓰지 않는다(transactional: false).
 */
export const copyToRmsStep: StepDef = {
  name: 'COPY_TO_RMS',
  transactional: false,
  isDone: async ({ db }) => (await findProjectId(db, RMS.key)) !== null,
  async run({ db, opts, report, log }) {
    const stdv1 = await stdv1Id(db);
    const adminLogin = opts.rmsAdmin ?? 'admin';
    const [admin] = await db
      .select({ id: tfUser.userId, active: tfUser.isActive })
      .from(tfUser)
      .where(eq(tfUser.loginId, adminLogin));
    if (!admin || !admin.active) {
      throw new StepFailure(
        `RMS 프로젝트 관리자 '${adminLogin}' 사용자가 ${admin ? '비활성입니다' : '없습니다'} — ` +
          '서버를 한 번 기동해 초기 관리자를 만들거나(§7.5 부트스트랩) --rms-admin=<로그인ID>로 활성 사용자를 지정하십시오',
      );
    }
    const src: CopySource = { kind: 'TEMPLATE', projectId: stdv1, key: 'STDV1' };
    const plan: CopyPlan = {
      operation: 'CREATE',
      target: {
        projectKey: RMS.key,
        projectNm: RMS.nm,
        description: "gen-table에서 승계한 RP_ 테이블 33개 · 템플릿 'TermFlow 기본 표준 v1'에서 생성",
        kind: 'PROJECT',
        defaultDialect: 'POSTGRESQL',
      },
      sources: {
        bizAreas: src,
        terms: src,
        domainClasses: src,
        domains: src,
        codes: src,
        defaultColSets: src,
      },
      bizCds: null,
      approvedOnly: false,
      creatorUserId: admin.id,
      members: [],
      warnings: [],
    };
    // 건수 검증은 엔진 트랜잭션 안에서(실패하면 RMS가 남지 않는다)
    const out = await executeCopy(db, plan, MIGRATION_AUDIT, {
      verify: (o) => {
        const short = o.items.filter((i) => i.copied !== i.sourceCnt);
        if (short.length > 0) {
          throw new StepFailure(
            `STDV1 전 항목이 복사되지 않았습니다: ${short.map((i) => `${i.item} ${i.copied}/${i.sourceCnt}`).join(', ')}`,
          );
        }
      },
    });
    report.writeTable(
      'copy_to_rms',
      COPY_TO_RMS_HEADER,
      out.items.map((i) => [
        i.item,
        i.sourceKind,
        i.sourceKey,
        i.sourceCnt,
        i.copied,
        i.skipped,
        i.flagged,
        i.elapsedMs,
      ]),
    );
    for (const i of out.items) {
      log(
        `[migrate:seed]   복사 ${i.item.padEnd(15)} 원본 ${String(i.sourceCnt).padStart(5)} → 복사 ${String(i.copied).padStart(5)} (${i.elapsedMs}ms)`,
      );
    }
    return {
      source: out.items.reduce((s, i) => s + i.sourceCnt, 0),
      loaded: out.items.reduce((s, i) => s + i.copied, 0),
      excluded: out.items.reduce((s, i) => s + i.skipped, 0),
      flagged: out.c3Revalidation.reviewDomainCnt,
      message:
        `RMS(project_id ${out.projectId}) 생성 ${out.elapsedMs}ms · ` +
        `복사 합 elapsed ${out.items.reduce((s, i) => s + (i.elapsedMs ?? 0), 0)}ms · ` +
        `C3 ${out.c3Revalidation.performed ? '수행' : '생략(원본 동일)'} · 검토 도메인 ${out.c3Revalidation.reviewDomainCnt} · 관리자 ${adminLogin}`,
    };
  },
};
