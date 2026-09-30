-- =====================================================================
-- test/seed/std_small.sql — 단위·통합 테스트 픽스처(설계서 §13.3, TODO T2.12)
-- 템플릿 1(STDS) + 프로젝트 2(PRJA·PRJB: 같은 업무구분 RP·같은 테이블명, 서로 다른 표준)
-- 각 프로젝트(템플릿 포함): 업무구분 2·용어 50·도메인분류 20·도메인 100·코드구분 5·코드 30·기본컬럼 세트 1 + 9
-- 사용자 4명(역할 4종): sysadmin(시스템 관리자), pa(PRJA·PRJB 프로젝트 관리자), editor(PRJA 편집자), viewer(PRJA 조회자)
-- 비밀번호는 모두 테스트 전용 값(bcrypt cost 10, 원문은 test/db/setup/fixtures.ts의 FIXTURE_PASSWORD)
-- PRJA는 STDS에서 복사한 것처럼 origin_project_id·origin_id를 채운다(PRJB는 직접 등록: NULL)
-- 실행 전제: 0001_baseline 적용 직후의 빈 DB
-- =====================================================================

INSERT INTO tf_user (login_id, user_nm, email, password_hash, is_sys_admin, pw_change_required, created_by, updated_by) VALUES
  ('sysadmin', '시스템관리자', 'sysadmin@example.test', '$2b$10$pZUk3zRUImVCkeFRrfGPled5xT6epm5BvJHPQGuXnAalrQdSBZL9m', TRUE,  FALSE, 'SYSTEM', 'SYSTEM'),
  ('pa',       '프로젝트관리자', 'pa@example.test',    '$2b$10$pZUk3zRUImVCkeFRrfGPled5xT6epm5BvJHPQGuXnAalrQdSBZL9m', FALSE, FALSE, 'SYSTEM', 'SYSTEM'),
  ('editor',   '편집자',       'editor@example.test', '$2b$10$pZUk3zRUImVCkeFRrfGPled5xT6epm5BvJHPQGuXnAalrQdSBZL9m', FALSE, FALSE, 'SYSTEM', 'SYSTEM'),
  ('viewer',   '조회자',       'viewer@example.test', '$2b$10$pZUk3zRUImVCkeFRrfGPled5xT6epm5BvJHPQGuXnAalrQdSBZL9m', FALSE, FALSE, 'SYSTEM', 'SYSTEM');

INSERT INTO tf_project (project_key, project_nm, kind, created_by, updated_by) VALUES
  ('STDS', '소형 표준 템플릿', 'TEMPLATE', 'MIGRATION', 'MIGRATION'),
  ('PRJA', '프로젝트 A',      'PROJECT',  'sysadmin',  'sysadmin'),
  ('PRJB', '프로젝트 B',      'PROJECT',  'sysadmin',  'sysadmin');
UPDATE tf_project SET copied_from_project_id = (SELECT project_id FROM tf_project WHERE project_key = 'STDS')
 WHERE project_key = 'PRJA';

-- 프로젝트별 표준 사전: 키 첫 글자(S/A/B)로 물리명을 달리해 "서로 다른 표준"을 만든다
DO $$
DECLARE
  p   RECORD;
  src INTEGER := (SELECT project_id FROM tf_project WHERE project_key = 'STDS');
  k   TEXT;
  o   INTEGER;  -- origin_project_id(PRJA만)
  v_set INTEGER;
BEGIN
  FOR p IN SELECT project_id, project_key FROM tf_project ORDER BY project_id LOOP
    k := left(p.project_key, 1) || CASE p.project_key WHEN 'STDS' THEN 'S' WHEN 'PRJA' THEN 'A' ELSE 'B' END;
    o := CASE WHEN p.project_key = 'PRJA' THEN src END;

    INSERT INTO prj_biz_area (project_id, biz_cd, biz_nm, table_prefix, sort_no, origin_project_id, origin_id, created_by, updated_by)
    SELECT p.project_id, cd, nm, cd || '_', ord, o,
           CASE WHEN o IS NOT NULL THEN (SELECT b.biz_area_id FROM prj_biz_area b WHERE b.project_id = src AND b.biz_cd = cd) END,
           'MIGRATION', 'MIGRATION'
      FROM unnest(ARRAY['RP', 'PS'], ARRAY['연구과제', '인사']) WITH ORDINALITY AS t(cd, nm, ord);

    INSERT INTO std_term (project_id, term_kor, term_physical, description, status, origin_project_id, origin_id, created_by, updated_by)
    SELECT p.project_id, '용어' || g, k || '_T' || g, '설명 ' || g,
           CASE WHEN g > 48 THEN 'PENDING' ELSE 'APPROVED' END, o,
           CASE WHEN o IS NOT NULL THEN (SELECT t.term_id FROM std_term t WHERE t.project_id = src AND t.term_kor = '용어' || g) END,
           'MIGRATION', 'MIGRATION'
      FROM generate_series(1, 50) g;

    INSERT INTO std_domain_cls (project_id, suffix, cls_nm, col_type, col_length, col_scale, origin_project_id, created_by, updated_by)
    SELECT p.project_id, 'SFX' || lpad(g::text, 2, '0'), '분류' || g,
           CASE WHEN g % 5 = 0 THEN 'NUMERIC' WHEN g % 7 = 0 THEN 'TIMESTAMP' ELSE 'VARCHAR' END,
           CASE WHEN g % 7 = 0 THEN 0 ELSE 10 + g END,
           CASE WHEN g % 5 = 0 THEN 2 END, o, 'MIGRATION', 'MIGRATION'
      FROM generate_series(1, 20) g;

    INSERT INTO std_domain (project_id, nm1, nm2, logical_nm, physical_nm, suffix, domain_cls_id, col_type, col_length, col_scale,
                            review_yn, origin_project_id, created_by, updated_by)
    SELECT p.project_id, '용어' || (g % 50 + 1), '분류' || (g % 20 + 1), '용어' || (g % 50 + 1) || '분류' || (g % 20 + 1) || '_' || g,
           k || '_T' || (g % 50 + 1) || '_' || c.suffix, c.suffix, c.domain_cls_id, c.col_type, c.col_length, c.col_scale,
           g % 25 = 0, o, 'MIGRATION', 'MIGRATION'
      FROM generate_series(1, 100) g
      JOIN std_domain_cls c ON c.project_id = p.project_id AND c.suffix = 'SFX' || lpad((g % 20 + 1)::text, 2, '0');

    INSERT INTO std_code_cls (project_id, biz_area_id, code_cls, code_cls_nm, origin_project_id, created_by, updated_by)
    SELECT p.project_id, b.biz_area_id, b.biz_cd || lpad(g::text, 3, '0'), '코드구분' || g, o, 'MIGRATION', 'MIGRATION'
      FROM generate_series(1, 5) g
      JOIN prj_biz_area b ON b.project_id = p.project_id AND b.biz_cd = CASE WHEN g <= 3 THEN 'RP' ELSE 'PS' END;

    INSERT INTO std_code (project_id, code_cls_id, code, code_nm, sort_order, origin_project_id, created_by, updated_by)
    SELECT p.project_id, c.code_cls_id, lpad(n::text, 2, '0'), '코드' || n, n, o, 'MIGRATION', 'MIGRATION'
      FROM std_code_cls c CROSS JOIN generate_series(1, 6) n
     WHERE c.project_id = p.project_id;

    INSERT INTO std_default_col_set (project_id, set_nm, is_default, origin_project_id, created_by, updated_by)
    VALUES (p.project_id, '기본', TRUE, o, 'MIGRATION', 'MIGRATION')
    RETURNING std_default_col_set.set_id INTO v_set;

    INSERT INTO std_default_col (project_id, set_id, col_seq, logical_nm, physical_nm, data_type, data_length, is_nullable, default_val,
                                 origin_project_id, created_by, updated_by)
    SELECT p.project_id, v_set, g, v.lnm, v.pnm, v.typ, v.len, TRUE, v.dflt, o, 'MIGRATION', 'MIGRATION'
      FROM (VALUES
        (1, '작업비고',        'WRK_RMK',          'VARCHAR',   100, NULL),
        (2, '최초등록프로그램ID', 'FIRS_REG_PGM_ID', 'VARCHAR',   50,  NULL),
        (3, '최초등록일시',     'FIRS_REG_DTS',     'TIMESTAMP', 0,   'CURRENT_TIMESTAMP'),
        (4, '최초등록자ID',     'FIRS_RGSRT_ID',    'VARCHAR',   20,  NULL),
        (5, '최초등록IP',      'FIRS_REG_IP',      'VARCHAR',   50,  NULL),
        (6, '최종등록프로그램ID', 'FINA_REG_PGM_ID', 'VARCHAR',   50,  NULL),
        (7, '최종등록일시',     'FINA_REG_DTS',     'TIMESTAMP', 0,   'CURRENT_TIMESTAMP'),
        (8, '최종등록자ID',     'FINA_RGSRT_ID',    'VARCHAR',   20,  NULL),
        (9, '최종등록IP',      'FINA_REG_IP',      'VARCHAR',   50,  NULL)
      ) AS v(g, lnm, pnm, typ, len, dflt);

    UPDATE tf_project SET default_col_set_id = v_set WHERE project_id = p.project_id;
  END LOOP;
END $$;

-- 멤버(템플릿에는 멤버·테이블을 두지 않는다, §3.2)
INSERT INTO tf_project_member (project_id, user_id, member_role, created_by, updated_by)
SELECT p.project_id, u.user_id, r.role, 'sysadmin', 'sysadmin'
  FROM (VALUES ('PRJA', 'pa', 'ADMIN'), ('PRJA', 'editor', 'EDITOR'), ('PRJA', 'viewer', 'VIEWER'), ('PRJB', 'pa', 'ADMIN'))
       AS r(project_key, login_id, role)
  JOIN tf_project p ON p.project_key = r.project_key
  JOIN tf_user u ON u.login_id = r.login_id;

-- 두 프로젝트에 같은 이름의 테이블(업무구분 RP) + 컬럼 3개(자기 프로젝트의 도메인·코드구분·기본컬럼만 참조)
INSERT INTO prj_table (project_id, biz_area_id, table_nm, table_logical_nm, created_by, updated_by)
SELECT p.project_id, b.biz_area_id, 'RP_RSCH_PRJ_MAST', '연구과제마스터', 'editor', 'editor'
  FROM tf_project p JOIN prj_biz_area b ON b.project_id = p.project_id AND b.biz_cd = 'RP'
 WHERE p.kind = 'PROJECT';

INSERT INTO prj_column (project_id, table_id, col_seq, logical_nm, physical_nm, is_pk, data_type, data_length, is_nullable,
                        domain_id, code_cls_id, default_col_id, match_type, created_by, updated_by)
SELECT t.project_id, t.table_id, v.seq, v.lnm, v.pnm, v.pk, 'VARCHAR', 20, NOT v.pk,
       CASE WHEN v.seq = 1 THEN (SELECT min(domain_id) FROM std_domain d WHERE d.project_id = t.project_id) END,
       CASE WHEN v.seq = 2 THEN (SELECT min(code_cls_id) FROM std_code_cls c WHERE c.project_id = t.project_id) END,
       CASE WHEN v.seq = 3 THEN (SELECT min(default_col_id) FROM std_default_col c WHERE c.project_id = t.project_id) END,
       v.mt, 'editor', 'editor'
  FROM prj_table t
 CROSS JOIN (VALUES (1, '연구과제ID', 'RSCH_PRJ_ID', TRUE, 'EXACT'),
                    (2, '진행상태코드', 'PRGRS_STAT_CD', FALSE, 'CODE'),
                    (3, '작업비고', 'WRK_RMK', FALSE, 'DEFAULT')) AS v(seq, lnm, pnm, pk, mt);
