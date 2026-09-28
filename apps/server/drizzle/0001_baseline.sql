-- 출처: docs/02_설계서.md v1.1(2026-09-28) 부록 A `V1__baseline.sql` 전문. 아래 본문은 내용 변경 금지(SQL이 진실, §2.5.3).
-- 적용: drizzle-orm migrator(`pnpm db:migrate`), 이력 drizzle.__drizzle_migrations. 전진 전용(down 없음), 복구는 백업.
-- =====================================================================
-- TermFlow V1__baseline.sql  (PostgreSQL 17, v1.1 — CR-01 반영)
-- 순수 PostgreSQL SQL: drizzle-kit(custom SQL, 확정) / node-pg-migrate / Flyway 어디서나 사용 가능
-- 원칙: 정수 IDENTITY PK, 감사컬럼 6개, 상태값 VARCHAR+CHECK, 표준 타입 12종
--       프로젝트 소유 테이블은 project_id NOT NULL, 교차 프로젝트 참조는 복합 FK로 차단
--       ON DELETE SET NULL (col) 열 지정 구문은 PostgreSQL 15 이상 필요
-- 승계 데이터는 스키마 마이그레이션 도구가 아닌 승계 러너가 적재한다(설계서 11절)
-- =====================================================================

-- 1. 사용자(전역)
CREATE TABLE tf_user (
    user_id             INTEGER GENERATED ALWAYS AS IDENTITY,
    login_id            VARCHAR(50)  NOT NULL,
    user_nm             VARCHAR(100) NOT NULL,
    email               VARCHAR(100),
    password_hash       VARCHAR(100) NOT NULL,
    is_sys_admin        BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    pw_change_required  BOOLEAN      NOT NULL DEFAULT TRUE,
    login_fail_cnt      SMALLINT     NOT NULL DEFAULT 0,
    locked_until        TIMESTAMP(0),
    last_login_at       TIMESTAMP(0),
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_tf_user PRIMARY KEY (user_id),
    CONSTRAINT uk_tf_user_login UNIQUE (login_id)
);
COMMENT ON TABLE  tf_user IS '사용자(전역)';
COMMENT ON COLUMN tf_user.is_sys_admin IS '시스템 관리자(사용자·템플릿·프로젝트 생성/보관/삭제, 전 프로젝트 관리자 권한)';
COMMENT ON COLUMN tf_user.pw_change_required IS '최초 로그인·초기화 후 비밀번호 변경 강제';

-- 2. 프로젝트·템플릿 (default_col_set_id FK는 순환 참조라 10절 이후 ALTER로 추가)
CREATE TABLE tf_project (
    project_id              INTEGER GENERATED ALWAYS AS IDENTITY,
    project_key             VARCHAR(10)  NOT NULL,
    project_nm              VARCHAR(100) NOT NULL,
    description             TEXT,
    kind                    VARCHAR(10)  NOT NULL DEFAULT 'PROJECT',
    status                  VARCHAR(10)  NOT NULL DEFAULT 'ACTIVE',
    default_dialect         VARCHAR(20)  NOT NULL DEFAULT 'POSTGRESQL',
    default_col_set_id      INTEGER,
    include_default_cols    BOOLEAN      NOT NULL DEFAULT TRUE,
    copied_from_project_id  INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_tf_project PRIMARY KEY (project_id),
    CONSTRAINT uk_tf_project_key UNIQUE (project_key),
    CONSTRAINT ck_tf_project_key_fmt CHECK (project_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
    CONSTRAINT ck_tf_project_kind CHECK (kind IN ('PROJECT','TEMPLATE')),
    CONSTRAINT ck_tf_project_status CHECK (status IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT ck_tf_project_dialect CHECK (default_dialect IN ('POSTGRESQL','ORACLE','MYSQL')),
    CONSTRAINT fk_tf_project_copied_from FOREIGN KEY (copied_from_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL
);
COMMENT ON TABLE  tf_project IS '프로젝트(스페이스) 및 표준 템플릿(kind=TEMPLATE, 읽기 전용)';
COMMENT ON COLUMN tf_project.project_key IS 'URL·식별용 키(예 RMS). 테이블 접두어는 업무구분 table_prefix가 결정';
COMMENT ON COLUMN tf_project.copied_from_project_id IS '생성 시 대표 원본(항목별 원본은 project_copy_log)';

CREATE TABLE tf_project_member (
    project_id   INTEGER     NOT NULL,
    user_id      INTEGER     NOT NULL,
    member_role  VARCHAR(10) NOT NULL,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_tf_project_member PRIMARY KEY (project_id, user_id),
    CONSTRAINT fk_member_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES tf_user (user_id),
    CONSTRAINT ck_member_role CHECK (member_role IN ('ADMIN','EDITOR','VIEWER'))
);
CREATE INDEX ix_tf_project_member_user ON tf_project_member (user_id);
COMMENT ON TABLE  tf_project_member IS '프로젝트 멤버(ADMIN=프로젝트 관리자, EDITOR=편집자, VIEWER=조회자)';

-- 3. 업무구분
CREATE TABLE prj_biz_area (
    biz_area_id        INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    biz_cd             VARCHAR(10)  NOT NULL,
    biz_nm             VARCHAR(100) NOT NULL,
    table_prefix       VARCHAR(20),
    sort_no            SMALLINT     NOT NULL DEFAULT 0,
    use_yn             BOOLEAN      NOT NULL DEFAULT TRUE,
    description        VARCHAR(500),
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_prj_biz_area PRIMARY KEY (biz_area_id),
    CONSTRAINT uk_prj_biz_area_cd UNIQUE (project_id, biz_cd),
    CONSTRAINT uk_prj_biz_area_pid UNIQUE (project_id, biz_area_id),
    CONSTRAINT fk_prj_biz_area_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_prj_biz_area_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT ck_prj_biz_area_cd_fmt CHECK (biz_cd ~ '^[A-Z][A-Z0-9]{1,9}$'),
    CONSTRAINT ck_prj_biz_area_prefix_fmt CHECK (table_prefix IS NULL OR table_prefix ~ '^[A-Z][A-Z0-9_]*$')
);
CREATE INDEX ix_prj_biz_area_sort ON prj_biz_area (project_id, sort_no);
COMMENT ON TABLE  prj_biz_area IS '업무구분(테이블 물리명 접두어 + 코드정보 업무구분 공통 마스터)';
COMMENT ON COLUMN prj_biz_area.table_prefix IS '물리명 제안 접두어. 등록 시 기본 biz_cd||''_''(서비스). NULL=접두어 없음';

-- 4. 표준 사전(프로젝트 소유)
CREATE TABLE std_term (
    term_id            INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    term_kor           VARCHAR(100) NOT NULL,
    term_physical      VARCHAR(30),
    description        VARCHAR(500),
    synonym_ref        VARCHAR(200),
    status             VARCHAR(10)  NOT NULL DEFAULT 'APPROVED',
    review_yn          BOOLEAN      NOT NULL DEFAULT FALSE,
    review_note        VARCHAR(500),
    reviewed_by        VARCHAR(50),
    reviewed_at        TIMESTAMP(0),
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_term PRIMARY KEY (term_id),
    CONSTRAINT uk_std_term_kor UNIQUE (project_id, term_kor),
    CONSTRAINT fk_std_term_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_term_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT ck_std_term_status CHECK (status IN ('APPROVED','PENDING','REJECTED')),
    CONSTRAINT ck_std_term_physical_fmt CHECK (term_physical IS NULL OR term_physical ~ '^[A-Z0-9_]+$')
);
CREATE INDEX ix_std_term_physical ON std_term (project_id, term_physical);
CREATE INDEX ix_std_term_pending ON std_term (project_id, created_at) WHERE status = 'PENDING';
COMMENT ON TABLE  std_term IS '용어(한글 용어 ↔ 물리약어), 프로젝트별 독립 사본';
COMMENT ON COLUMN std_term.status IS 'APPROVED/PENDING(편집자 인라인 등록)/REJECTED';
COMMENT ON COLUMN std_term.origin_id IS '복사 원본 행 ID(C2). FK 없음';

CREATE TABLE std_domain_cls (
    domain_cls_id      INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    suffix             VARCHAR(30)  NOT NULL,
    cls_nm             VARCHAR(500) NOT NULL,
    col_type           VARCHAR(20)  NOT NULL,
    col_length         INTEGER,
    col_scale          INTEGER,
    description        VARCHAR(200),
    review_yn          BOOLEAN      NOT NULL DEFAULT FALSE,
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_domain_cls PRIMARY KEY (domain_cls_id),
    CONSTRAINT uk_std_domain_cls_suffix UNIQUE (project_id, suffix),
    CONSTRAINT uk_std_domain_cls_pid UNIQUE (project_id, domain_cls_id),
    CONSTRAINT fk_std_domain_cls_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_domain_cls_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT ck_std_domain_cls_suffix_fmt CHECK (suffix ~ '^[A-Z0-9_]+$'),
    CONSTRAINT ck_std_domain_cls_type CHECK (col_type IN ('VARCHAR','CHAR','TEXT','SMALLINT','INT','BIGINT','NUMERIC','DATE','TIMESTAMP','BOOLEAN','JSONB','BYTEA')),
    CONSTRAINT ck_std_domain_cls_len CHECK (review_yn OR col_type NOT IN ('VARCHAR','CHAR','NUMERIC') OR col_length IS NOT NULL)
);
COMMENT ON TABLE  std_domain_cls IS '도메인분류(접미어 → 표준 타입·길이·스케일)';
COMMENT ON COLUMN std_domain_cls.col_length IS 'VARCHAR/CHAR 길이, NUMERIC 정밀도, TIMESTAMP 소수 초 자릿수(정수)';

CREATE TABLE std_domain (
    domain_id          INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    nm1                VARCHAR(100) NOT NULL,
    nm2                VARCHAR(100),
    nm3                VARCHAR(100),
    nm4                VARCHAR(100),
    nm5                VARCHAR(100),
    nm6                VARCHAR(100),
    nm7                VARCHAR(100),
    logical_nm         VARCHAR(200) NOT NULL,
    physical_nm        VARCHAR(63),
    descr              VARCHAR(500),
    suffix             VARCHAR(30),
    domain_cls_id      INTEGER,
    col_type           VARCHAR(20),
    col_length         INTEGER,
    col_scale          INTEGER,
    type_source        VARCHAR(10)  NOT NULL DEFAULT 'AUTO',
    review_yn          BOOLEAN      NOT NULL DEFAULT FALSE,
    review_note        VARCHAR(500),
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_domain PRIMARY KEY (domain_id),
    CONSTRAINT uk_std_domain_logical UNIQUE (project_id, logical_nm),
    CONSTRAINT uk_std_domain_pid UNIQUE (project_id, domain_id),
    CONSTRAINT fk_std_domain_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_domain_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT fk_std_domain_cls FOREIGN KEY (project_id, domain_cls_id)
        REFERENCES std_domain_cls (project_id, domain_cls_id) ON DELETE SET NULL (domain_cls_id),
    CONSTRAINT ck_std_domain_type_source CHECK (type_source IN ('AUTO','MANUAL')),
    CONSTRAINT ck_std_domain_physical_fmt CHECK (physical_nm IS NULL OR physical_nm ~ '^[A-Z0-9][A-Z0-9_]*$'),
    CONSTRAINT ck_std_domain_type CHECK (col_type IS NULL OR col_type IN ('VARCHAR','CHAR','TEXT','SMALLINT','INT','BIGINT','NUMERIC','DATE','TIMESTAMP','BOOLEAN','JSONB','BYTEA'))
);
CREATE INDEX ix_std_domain_physical ON std_domain (project_id, physical_nm);
CREATE INDEX ix_std_domain_suffix ON std_domain (project_id, suffix);
CREATE INDEX ix_std_domain_review ON std_domain (project_id) WHERE review_yn;
COMMENT ON TABLE  std_domain IS '도메인(명칭 조각 1~7 → 표준 컬럼 논리명·물리명·타입)';
COMMENT ON COLUMN std_domain.type_source IS 'AUTO: 접미어 규칙 산출 / MANUAL: 수기 타입(재계산 시 유지)';

CREATE TABLE std_code_cls (
    code_cls_id        INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    biz_area_id        INTEGER      NOT NULL,
    code_cls           VARCHAR(10)  NOT NULL,
    code_cls_nm        VARCHAR(100) NOT NULL,
    description        VARCHAR(500),
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_code_cls PRIMARY KEY (code_cls_id),
    CONSTRAINT uk_std_code_cls UNIQUE (project_id, biz_area_id, code_cls),
    CONSTRAINT uk_std_code_cls_pid UNIQUE (project_id, code_cls_id),
    CONSTRAINT fk_std_code_cls_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_code_cls_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT fk_std_code_cls_biz_area FOREIGN KEY (project_id, biz_area_id)
        REFERENCES prj_biz_area (project_id, biz_area_id) ON DELETE CASCADE
);
CREATE INDEX ix_std_code_cls_nm ON std_code_cls (project_id, code_cls_nm);
COMMENT ON TABLE std_code_cls IS '코드구분(업무구분 소속)';

CREATE TABLE std_code (
    code_id            INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    code_cls_id        INTEGER      NOT NULL,
    code               VARCHAR(10)  NOT NULL,
    code_nm            VARCHAR(100) NOT NULL,
    sort_order         SMALLINT,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_code PRIMARY KEY (code_id),
    CONSTRAINT uk_std_code UNIQUE (code_cls_id, code),
    CONSTRAINT fk_std_code_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_code_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT fk_std_code_cls FOREIGN KEY (project_id, code_cls_id)
        REFERENCES std_code_cls (project_id, code_cls_id) ON DELETE CASCADE
);
COMMENT ON TABLE std_code IS '코드';

CREATE TABLE std_default_col_set (
    set_id             INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    set_nm             VARCHAR(50)  NOT NULL,
    description        VARCHAR(200),
    is_default         BOOLEAN      NOT NULL DEFAULT FALSE,
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_default_col_set PRIMARY KEY (set_id),
    CONSTRAINT uk_std_default_col_set_nm UNIQUE (project_id, set_nm),
    CONSTRAINT uk_std_default_col_set_pid UNIQUE (project_id, set_id),
    CONSTRAINT fk_std_default_col_set_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_default_col_set_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ux_std_default_col_set_default ON std_default_col_set (project_id) WHERE is_default;
COMMENT ON TABLE std_default_col_set IS '기본컬럼 세트(사용자 테이블 DDL에 붙는 공통 컬럼 묶음), 프로젝트당 기본 1개';

CREATE TABLE std_default_col (
    default_col_id     INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    set_id             INTEGER      NOT NULL,
    col_seq            SMALLINT     NOT NULL,
    logical_nm         VARCHAR(100) NOT NULL,
    physical_nm        VARCHAR(63)  NOT NULL,
    is_pk              BOOLEAN      NOT NULL DEFAULT FALSE,
    data_type          VARCHAR(20)  NOT NULL,
    data_length        INTEGER,
    data_scale         INTEGER,
    is_nullable        BOOLEAN      NOT NULL DEFAULT TRUE,
    default_val        VARCHAR(200),
    col_comment        VARCHAR(500),
    origin_project_id  INTEGER,
    origin_id          INTEGER,
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_std_default_col PRIMARY KEY (default_col_id),
    CONSTRAINT uk_std_default_col_seq UNIQUE (set_id, col_seq),
    CONSTRAINT uk_std_default_col_phys UNIQUE (set_id, physical_nm),
    CONSTRAINT uk_std_default_col_pid UNIQUE (project_id, default_col_id),
    CONSTRAINT fk_std_default_col_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_std_default_col_origin FOREIGN KEY (origin_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT fk_std_default_col_set FOREIGN KEY (project_id, set_id)
        REFERENCES std_default_col_set (project_id, set_id) ON DELETE CASCADE,
    CONSTRAINT ck_std_default_col_phys_fmt CHECK (physical_nm ~ '^[A-Z][A-Z0-9_]*$'),
    CONSTRAINT ck_std_default_col_type CHECK (data_type IN ('VARCHAR','CHAR','TEXT','SMALLINT','INT','BIGINT','NUMERIC','DATE','TIMESTAMP','BOOLEAN','JSONB','BYTEA'))
);
COMMENT ON TABLE std_default_col IS '기본컬럼 구성(승계 9개: WRK_RMK, FIRS_REG_*, FINA_REG_*)';

-- 순환 참조: 프로젝트 → 기본컬럼 세트(같은 프로젝트의 세트만)
ALTER TABLE tf_project ADD CONSTRAINT fk_tf_project_colset
    FOREIGN KEY (project_id, default_col_set_id)
    REFERENCES std_default_col_set (project_id, set_id) ON DELETE SET NULL (default_col_set_id);
COMMENT ON COLUMN tf_project.default_col_set_id IS '기본컬럼 세트(NULL이면 프로젝트의 is_default 세트)';

-- 5. 프로젝트 설계물
CREATE TABLE prj_table (
    table_id          INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id        INTEGER      NOT NULL,
    biz_area_id       INTEGER      NOT NULL,
    table_nm          VARCHAR(63)  NOT NULL,
    table_logical_nm  VARCHAR(200) NOT NULL,
    description       TEXT,
    status            VARCHAR(10)  NOT NULL DEFAULT 'DRAFT',
    version           INTEGER      NOT NULL DEFAULT 1,
    finalized_at      TIMESTAMP(0),
    finalized_by      VARCHAR(50),
    legacy_table_id   VARCHAR(50),
    review_yn         BOOLEAN      NOT NULL DEFAULT FALSE,
    review_note       VARCHAR(500),
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_prj_table PRIMARY KEY (table_id),
    CONSTRAINT uk_prj_table_nm UNIQUE (project_id, table_nm),
    CONSTRAINT uk_prj_table_pid UNIQUE (project_id, table_id),
    CONSTRAINT fk_prj_table_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_prj_table_biz_area FOREIGN KEY (project_id, biz_area_id)
        REFERENCES prj_biz_area (project_id, biz_area_id) ON DELETE NO ACTION,
    CONSTRAINT ck_prj_table_status CHECK (status IN ('DRAFT','FINAL')),
    CONSTRAINT ck_prj_table_nm_fmt CHECK (table_nm ~ '^[A-Z][A-Z0-9_]*$')
);
CREATE INDEX ix_prj_table_list ON prj_table (project_id, biz_area_id, status, updated_at DESC);
COMMENT ON TABLE  prj_table IS '테이블(프로젝트·업무구분 소속, 물리명은 프로젝트 내 유니크)';
COMMENT ON COLUMN prj_table.version IS '낙관적 잠금 버전. 저장마다 +1, prj_table_history.version과 동일';
COMMENT ON COLUMN prj_table.legacy_table_id IS '승계 원본 table_id(TBL_…), 대사용';

CREATE TABLE prj_column (
    column_id       INTEGER GENERATED ALWAYS AS IDENTITY,
    project_id      INTEGER      NOT NULL,
    table_id        INTEGER      NOT NULL,
    col_seq         SMALLINT     NOT NULL,
    logical_nm      VARCHAR(200) NOT NULL,
    physical_nm     VARCHAR(63)  NOT NULL,
    is_pk           BOOLEAN      NOT NULL DEFAULT FALSE,
    data_type       VARCHAR(20),
    data_length     INTEGER,
    data_scale      INTEGER,
    is_nullable     BOOLEAN      NOT NULL DEFAULT TRUE,
    default_val     VARCHAR(200),
    col_comment     VARCHAR(500),
    domain_id       INTEGER,
    code_cls_id     INTEGER,
    default_col_id  INTEGER,
    match_type      VARCHAR(12)  NOT NULL DEFAULT 'MANUAL',
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_prj_column PRIMARY KEY (column_id),
    CONSTRAINT fk_prj_column_table FOREIGN KEY (project_id, table_id)
        REFERENCES prj_table (project_id, table_id) ON DELETE CASCADE,
    CONSTRAINT fk_prj_column_domain FOREIGN KEY (project_id, domain_id)
        REFERENCES std_domain (project_id, domain_id) ON DELETE SET NULL (domain_id),
    CONSTRAINT fk_prj_column_code_cls FOREIGN KEY (project_id, code_cls_id)
        REFERENCES std_code_cls (project_id, code_cls_id) ON DELETE SET NULL (code_cls_id),
    CONSTRAINT fk_prj_column_default_col FOREIGN KEY (project_id, default_col_id)
        REFERENCES std_default_col (project_id, default_col_id) ON DELETE SET NULL (default_col_id),
    CONSTRAINT uk_prj_column_seq UNIQUE (table_id, col_seq) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT uk_prj_column_phys UNIQUE (table_id, physical_nm) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_prj_column_phys_fmt CHECK (physical_nm ~ '^[A-Z][A-Z0-9_]*$'),
    CONSTRAINT ck_prj_column_type CHECK (data_type IS NULL OR data_type IN ('VARCHAR','CHAR','TEXT','SMALLINT','INT','BIGINT','NUMERIC','DATE','TIMESTAMP','BOOLEAN','JSONB','BYTEA')),
    CONSTRAINT ck_prj_column_match CHECK (match_type IN ('EXACT','SIMILAR','COMPOSED','UNREGISTERED','CODE','DEFAULT','MANUAL')),
    CONSTRAINT ck_prj_column_pk_notnull CHECK (NOT is_pk OR NOT is_nullable)
);
CREATE INDEX ix_prj_column_domain ON prj_column (domain_id);
CREATE INDEX ix_prj_column_code_cls ON prj_column (code_cls_id);
COMMENT ON TABLE  prj_column IS '컬럼(표준 타입 3분할, 같은 프로젝트의 도메인·코드구분·기본컬럼만 참조)';
COMMENT ON COLUMN prj_column.project_id IS '복합 FK로 교차 프로젝트 참조를 막기 위한 비정규화(테이블의 project_id와 동일)';
COMMENT ON COLUMN prj_column.data_type IS 'NULL = 타입 미지정(저장 시 오류 E_TYPE_MISSING)';

CREATE TABLE prj_table_history (
    history_id      BIGINT GENERATED ALWAYS AS IDENTITY,
    table_id        INTEGER      NOT NULL,
    version         INTEGER      NOT NULL,
    action          VARCHAR(12)  NOT NULL,
    change_summary  VARCHAR(500),
    snapshot        JSONB        NOT NULL,
    saved_by        VARCHAR(50)  NOT NULL,
    saved_ip        VARCHAR(45),
    saved_at        TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_prj_table_history PRIMARY KEY (history_id),
    CONSTRAINT fk_prj_table_history_table FOREIGN KEY (table_id) REFERENCES prj_table (table_id) ON DELETE CASCADE,
    CONSTRAINT uk_prj_table_history_ver UNIQUE (table_id, version),
    CONSTRAINT ck_prj_table_history_action CHECK (action IN ('CREATE','UPDATE','RESTORE','FINALIZE','UNFINALIZE','CLONE','MIGRATE'))
);
COMMENT ON TABLE prj_table_history IS '테이블 저장 스냅샷(JSONB, 설계서 8.3)';

-- 6. 로그
CREATE TABLE std_audit_log (
    audit_id     BIGINT GENERATED ALWAYS AS IDENTITY,
    project_id   INTEGER      NOT NULL,
    entity_type  VARCHAR(20)  NOT NULL,
    entity_id    INTEGER      NOT NULL,
    action       VARCHAR(10)  NOT NULL,
    before_json  JSONB,
    after_json   JSONB,
    batch_id     VARCHAR(36),
    actor        VARCHAR(50)  NOT NULL,
    actor_ip     VARCHAR(45),
    acted_at     TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_std_audit_log PRIMARY KEY (audit_id),
    CONSTRAINT fk_std_audit_log_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT ck_std_audit_log_entity CHECK (entity_type IN ('BIZ_AREA','TERM','DOMAIN_CLS','DOMAIN','CODE_CLS','CODE','DEFAULT_COL_SET','DEFAULT_COL')),
    CONSTRAINT ck_std_audit_log_action CHECK (action IN ('INSERT','UPDATE','DELETE','APPROVE','REJECT','IMPORT','COPY'))
);
CREATE INDEX ix_std_audit_log_entity ON std_audit_log (project_id, entity_type, entity_id);
CREATE INDEX ix_std_audit_log_time ON std_audit_log (project_id, acted_at);
COMMENT ON TABLE std_audit_log IS '표준 사전·업무구분 변경 감사(프로젝트 범위, before/after JSON)';

CREATE TABLE ddl_export_log (
    export_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    project_id   INTEGER      NOT NULL,
    dialect      VARCHAR(20)  NOT NULL,
    output_kind  VARCHAR(10)  NOT NULL,
    table_ids    JSONB        NOT NULL,
    options      JSONB        NOT NULL,
    table_cnt    SMALLINT     NOT NULL,
    warning_cnt  SMALLINT     NOT NULL DEFAULT 0,
    exported_by  VARCHAR(50)  NOT NULL,
    exported_ip  VARCHAR(45),
    exported_at  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_ddl_export_log PRIMARY KEY (export_id),
    CONSTRAINT fk_ddl_export_log_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT ck_ddl_export_log_kind CHECK (output_kind IN ('COPY','DOWNLOAD','ZIP','EXTRACT'))
);
CREATE INDEX ix_ddl_export_log_project ON ddl_export_log (project_id, exported_at DESC);
COMMENT ON TABLE ddl_export_log IS 'DDL 내보내기 로그(미리보기 제외)';

CREATE TABLE project_copy_log (
    copy_id            BIGINT GENERATED ALWAYS AS IDENTITY,
    project_id         INTEGER      NOT NULL,
    batch_id           VARCHAR(36)  NOT NULL,
    operation          VARCHAR(10)  NOT NULL,
    item               VARCHAR(20)  NOT NULL,
    source_kind        VARCHAR(10)  NOT NULL,
    source_project_id  INTEGER,
    options            JSONB        NOT NULL DEFAULT '{}',
    source_cnt         INTEGER      NOT NULL DEFAULT 0,
    copied_cnt         INTEGER      NOT NULL DEFAULT 0,
    skipped_cnt        INTEGER      NOT NULL DEFAULT 0,
    flagged_cnt        INTEGER      NOT NULL DEFAULT 0,
    warnings           JSONB        NOT NULL DEFAULT '[]',
    elapsed_ms         INTEGER      NOT NULL DEFAULT 0,
    copied_by          VARCHAR(50)  NOT NULL,
    copied_at          TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_project_copy_log PRIMARY KEY (copy_id),
    CONSTRAINT fk_project_copy_log_project FOREIGN KEY (project_id) REFERENCES tf_project (project_id) ON DELETE CASCADE,
    CONSTRAINT fk_project_copy_log_source FOREIGN KEY (source_project_id) REFERENCES tf_project (project_id) ON DELETE SET NULL,
    CONSTRAINT ck_project_copy_log_op CHECK (operation IN ('CREATE','PUBLISH')),
    CONSTRAINT ck_project_copy_log_item CHECK (item IN ('BIZ_AREA','TERM','DOMAIN_CLS','DOMAIN','CODE_CLS','CODE','DEFAULT_COL_SET','DEFAULT_COL')),
    CONSTRAINT ck_project_copy_log_source CHECK (source_kind IN ('TEMPLATE','PROJECT','EMPTY'))
);
CREATE INDEX ix_project_copy_log_batch ON project_copy_log (project_id, batch_id);
COMMENT ON TABLE project_copy_log IS '프로젝트 생성·템플릿 게시 시 항목별 복사 결과(CR-01 C5)';

CREATE TABLE migration_log (
    migration_id  INTEGER GENERATED ALWAYS AS IDENTITY,
    run_id        VARCHAR(36)  NOT NULL,
    step          VARCHAR(30)  NOT NULL,
    rule_id       VARCHAR(5),
    source_cnt    INTEGER      NOT NULL DEFAULT 0,
    loaded_cnt    INTEGER      NOT NULL DEFAULT 0,
    excluded_cnt  INTEGER      NOT NULL DEFAULT 0,
    flagged_cnt   INTEGER      NOT NULL DEFAULT 0,
    status        VARCHAR(10)  NOT NULL,
    message       TEXT,
    report_path   VARCHAR(200),
    started_at    TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at   TIMESTAMP(0),
    CONSTRAINT pk_migration_log PRIMARY KEY (migration_id),
    CONSTRAINT ck_migration_log_status CHECK (status IN ('SUCCESS','FAILED','SKIPPED'))
);
CREATE INDEX ix_migration_log_run ON migration_log (run_id, step);
COMMENT ON TABLE migration_log IS '초기 데이터 승계 실행 로그(전역, 설계서 11절)';

-- 7. 서버 세션 저장소(connect-pg-simple 표준 스키마, N안 확정으로 사용)
CREATE TABLE tf_session (
    sid     VARCHAR      NOT NULL,
    sess    JSON         NOT NULL,
    expire  TIMESTAMP(6) NOT NULL,
    CONSTRAINT pk_tf_session PRIMARY KEY (sid)
);
CREATE INDEX ix_tf_session_expire ON tf_session (expire);
COMMENT ON TABLE tf_session IS 'express-session 저장소(connect-pg-simple, tableName=tf_session)';
