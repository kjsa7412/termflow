// drizzle-kit pull 산출물(schema.ts) 결정적 후처리(T1.4 PoC 발견 → T2.2 db:pull).
// SQL(drizzle/*.sql)이 진실이고 schema.ts는 쿼리 타입용이다. drizzle-kit 0.31 pull은
//  ① 복합 FK의 참조 열 순서를 뒤바꾸고(attnum 순) ② `ON DELETE SET NULL (열)`의 열 목록과 DEFERRABLE을 버리며
//  ③ tf_project ↔ std_default_col_set 순환 FK 때문에 strict tsc에서 TS7022(암시적 any)를 낸다.
// 그래서 foreignKey(...) 항목을 제거한다(관계는 손으로 쓴 relations.ts가 담당). 그 밖의 내용은 바꾸지 않는다.

const HEADER = `// ⚠ 자동 생성 파일 — 직접 수정 금지. \`pnpm db:pull\`(drizzle-kit pull + scripts/pull-postprocess.ts)로 다시 만든다.
// 진실은 drizzle/*.sql(설계서 §2.5.3). 이 파일은 쿼리 타입용이며 다음을 담지 않는다(PoC T1.4 발견):
//  - FOREIGN KEY 전부(pull의 복합 FK 열 순서 오류·SET NULL(열) 누락·순환 참조 타입 오류 때문에 제거)
//  - DEFERRABLE, ON DELETE SET NULL (열)
//  - 다열 unique의 열 순서는 attnum 순으로 나올 수 있다(메타데이터일 뿐, DDL 생성에 쓰지 않는다)
`;

/** `foreignKey({ ... })` 호출과 뒤따르는 `.onDelete(...)`/`.onUpdate(...)` 체인, 끝의 쉼표까지 제거한다. */
function stripForeignKeys(src: string): string {
  let out = '';
  let i = 0;
  const token = 'foreignKey({';
  for (;;) {
    const at = src.indexOf(token, i);
    if (at < 0) break;
    // 줄 시작(들여쓰기)부터 지운다
    let lineStart = src.lastIndexOf('\n', at) + 1;
    if (src.slice(lineStart, at).trim() !== '') lineStart = at;
    out += src.slice(i, lineStart);
    // 괄호 균형으로 foreignKey( … ) 끝을 찾는다
    let depth = 0;
    let j = at + 'foreignKey'.length;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    // .onDelete("…") / .onUpdate("…") 체인
    for (;;) {
      const m = /^\s*\.(onDelete|onUpdate)\("[^"]*"\)/.exec(src.slice(j));
      if (!m) break;
      j += m[0].length;
    }
    const tail = /^,?[ \t]*\r?\n/.exec(src.slice(j));
    if (tail) j += tail[0].length;
    i = j;
  }
  return out + src.slice(i);
}

export function postprocessSchema(src: string): string {
  let s = stripForeignKeys(src);
  // 더 이상 쓰지 않는 import 제거
  s = s.replace(/\btype AnyPgColumn, /, '').replace(/\bforeignKey, /, '');
  // 제약이 모두 빠진 빈 extra config `, (table) => [\n]` 정리
  s = s.replace(/\}, \(table\) => \[\s*\]\);/g, '});');
  return HEADER + s;
}
