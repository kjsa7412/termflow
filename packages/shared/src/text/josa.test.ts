import { describe, expect, it } from 'vitest';
import { fillJosa } from './josa.js';

// CR-15 C13: "QATEST을(를)"처럼 조사 자리를 그대로 보이지 않게
describe('fillJosa', () => {
  it('한글 받침 유무·ㄹ 받침', () => {
    expect(fillJosa("'연구'은(는) 이미 있습니다")).toBe("'연구'는 이미 있습니다");
    expect(fillJosa("'멘토' 검토대기을(를) 등록")).toBe("'멘토' 검토대기를 등록");
    expect(fillJosa('업무구분 RP 연구과제을(를) 추가했습니다')).toBe(
      '업무구분 RP 연구과제를 추가했습니다',
    );
    expect(fillJosa('편집자(으)로 추가했습니다')).toBe('편집자로 추가했습니다');
    expect(fillJosa('조회자(으)로 바꿨습니다 · 관리자을(를) 지정')).toBe(
      '조회자로 바꿨습니다 · 관리자를 지정',
    );
    expect(fillJosa('사경진이(가) 저장했습니다')).toBe('사경진이 저장했습니다');
    expect(fillJosa('서울(으)로 · 집(으)로')).toBe('서울로 · 집으로');
  });

  it('영문·숫자는 읽는 소리로', () => {
    expect(fillJosa('프로젝트 QATEST을(를) 만들었습니다')).toBe('프로젝트 QATEST를 만들었습니다');
    expect(fillJosa("'멘토' MNTR을(를) 검토대기로")).toBe("'멘토' MNTR를 검토대기로");
    expect(fillJosa('ORDER은(는) 예약어 · LEVEL은(는) 예약어')).toBe(
      'ORDER는 예약어 · LEVEL은 예약어',
    );
    expect(fillJosa('RP_RSCH_PRJ_PRTN_HST_COPY(으)로 복제')).toBe(
      'RP_RSCH_PRJ_PRTN_HST_COPY로 복제',
    );
    expect(fillJosa('물리명 EMP_NO이(가) 2행과 중복')).toBe('물리명 EMP_NO가 2행과 중복');
    expect(fillJosa('PK_RP_T_ITEM(으)로 축약')).toBe('PK_RP_T_ITEM으로 축약');
    expect(fillJosa('v1(으)로 복원 · v2(으)로 복원 · v3(으)로')).toBe(
      'v1로 복원 · v2로 복원 · v3으로',
    );
    expect(fillJosa('VARCHAR(4000)이(가) 상한')).toBe('VARCHAR(4000)이 상한');
  });

  it('판단할 수 없으면 그대로, 조사 자리가 없으면 원문', () => {
    expect(fillJosa('—을(를) 확인')).toBe('—을(를) 확인');
    expect(fillJosa('그대로 둡니다(선택)')).toBe('그대로 둡니다(선택)');
  });
});
