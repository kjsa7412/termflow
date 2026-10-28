import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { autocompleteRequestSchema } from './autocomplete.js';
import { ddlRequestSchema } from './ddl-options.js';
import { projectCreateSchema } from './project.js';
import { tableSaveSchema } from './table.js';
import { termInlineSchema } from './term.js';

// T2.11 DoD: 설계서 §9.5(및 §5.4) JSON 예시가 스키마로 파싱된다. 예시는 설계서에서 직접 읽는다.
const here = path.dirname(fileURLToPath(import.meta.url));
// 설계서는 개발 PC에만 있다(저장소에 없음, .gitignore) — 없으면(CI·새 clone) 이 파일을 건너뛴다
const DOC = path.resolve(here, '../../../../docs/02_설계서.md');
const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8').split('\r\n').join('\n') : '';

/** `label` 뒤에 처음 나오는 ```json 블록을 JSON으로 읽는다. */
function exampleAfter(label: string, from = 0): unknown {
  const at = doc.indexOf(label, from);
  if (at < 0) throw new Error(`설계서에서 찾을 수 없음: ${label}`);
  const start = doc.indexOf('```json\n', at) + '```json\n'.length;
  return JSON.parse(doc.slice(start, doc.indexOf('```', start)));
}

const sec95 = doc.indexOf('### 9.5 주요 JSON 예시');
const sec54 = doc.indexOf('### 5.4 자동완성 API 규격');

describe.skipIf(!doc)('schemas — 설계서 예시 파싱', () => {
  it('§9.5 프로젝트 생성 요청', () => {
    const r = projectCreateSchema.parse(exampleAfter('프로젝트 생성 요청', sec95));
    expect(r.projectKey).toBe('RMS26');
    expect(r.imports.bizAreas.bizCds).toEqual(['RP', 'PS', 'AC']);
    expect(r.imports.terms.approvedOnly).toBe(true);
    expect(r.members).toHaveLength(2);
  });

  it('§9.5 테이블 저장 요청(생략 필드는 기본값)', () => {
    const r = tableSaveSchema.parse(exampleAfter('테이블 저장 요청', sec95));
    expect(r.version).toBe(3);
    expect(r.columns).toHaveLength(3);
    expect(r.columns[1]).toMatchObject({ columnId: null, dataScale: null, defaultVal: null });
    expect(r.columns[2]?.matchType).toBe('DEFAULT');
  });

  it('§9.5 DDL 생성 요청', () => {
    const r = ddlRequestSchema.parse(exampleAfter('DDL 생성 요청', sec95));
    expect(r.options.codeColumnStyle).toBe('COMMENT_SUMMARY');
    expect(r.options.includeHeader).toBe(true); // 생략 → 기본값
  });

  it('§5.4 자동완성 요청·인라인 용어 등록', () => {
    expect(autocompleteRequestSchema.parse(exampleAfter('요청', sec54)).logicalNm).toBe(
      '연구과제번호',
    );
    const inline = termInlineSchema.parse(exampleAfter('인라인 용어 등록', sec54));
    expect(inline).toEqual({
      termKor: '책임자',
      termPhysical: 'RESP',
      description: 'responsible person',
    });
  });

  it('형식 오류는 거부한다', () => {
    expect(projectCreateSchema.safeParse({ projectKey: 'rms' }).success).toBe(false);
    const noKey = projectCreateSchema.safeParse({
      projectKey: 'ABC',
      projectNm: 'x',
      imports: {
        bizAreas: { source: 'TEMPLATE' },
        terms: { source: 'EMPTY' },
        domainClasses: { source: 'EMPTY' },
        domains: { source: 'EMPTY' },
        codes: { source: 'EMPTY' },
        defaultColSets: { source: 'EMPTY' },
      },
    });
    expect(noKey.success).toBe(false);
    expect(ddlRequestSchema.safeParse({ dialect: 'POSTGRESQL' }).success).toBe(false);
    expect(autocompleteRequestSchema.safeParse({ logicalNm: '  ' }).success).toBe(false);
  });
});
