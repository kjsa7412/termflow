/**
 * 외부 연동 도구 이름·설명(CR-18 C5). 키 = `컨트롤러 클래스.핸들러`. REST 라우트 하나 = 도구 하나이고, 입력 스키마는
 * 라우트의 zod 파이프에서 자동으로 만든다(route-catalog.ts). 새 라우트를 추가하면 여기에 이름·설명을 넣거나 `exclude`로
 * 제외 사유를 적어야 한다 — 빠지면 test:db `mcp.test.ts`가 실패한다.
 */
export interface ToolSpec {
  name: string;
  description: string;
}
export interface ExcludedSpec {
  exclude: string;
}

export const TOOL_SPECS: Record<string, ToolSpec | ExcludedSpec> = {
  // ── 제외(사람이 웹에서) ───────────────────────────────────────────────
  'AuthController.issue': { exclude: '세션 로그인 전용' },
  'AuthController.login': { exclude: '세션 로그인 전용' },
  'AuthController.logout': { exclude: '세션 로그인 전용' },
  'MeController.changePassword': { exclude: '비밀번호는 사람이 바꾼다' },
  'MeTokensController.list': { exclude: '토큰 관리는 웹 전용' },
  'MeTokensController.issue': { exclude: '토큰 관리는 웹 전용' },
  'MeTokensController.revoke': { exclude: '토큰 관리는 웹 전용' },
  'AdminUsersController.resetPassword': { exclude: '임시 비밀번호가 응답으로 나간다' },
  'HealthController.check': { exclude: '운영 점검용' },
  'MetricsController.metricsText': { exclude: '운영 점검용' },
  'ImportController.template': { exclude: 'xlsx 파일 응답' },
  'ImportController.upload': { exclude: 'xlsx 파일 업로드(multipart)' },
  'ImportController.get': { exclude: '업로드와 짝(웹 전용)' },
  'ImportController.apply': { exclude: '업로드와 짝(웹 전용)' },
  'ImportController.cancel': { exclude: '업로드와 짝(웹 전용)' },
  'McpController.post': { exclude: '연동 엔드포인트 자신' },
  'McpController.get': { exclude: '연동 엔드포인트 자신' },
  'McpController.remove': { exclude: '연동 엔드포인트 자신' },

  // ── 내 계정·프로젝트 ──────────────────────────────────────────────────
  'MeController.me': {
    name: 'whoami',
    description:
      '토큰 주인의 계정과 소속 프로젝트·역할(ADMIN/EDITOR/VIEWER) 목록. 작업 전에 먼저 불러 쓸 프로젝트 키와 권한을 확인한다.',
  },
  'ProjectsController.list': {
    name: 'projects_list',
    description: '접근할 수 있는 프로젝트 카드 목록(키·이름·상태·테이블 수).',
  },
  'ProjectsController.home': {
    name: 'project_get',
    description: '프로젝트 홈 요약(업무구분별 테이블 수, 표준 사전 건수, 승인 대기 등).',
  },
  'ProjectsController.settings': {
    name: 'project_settings_get',
    description: '프로젝트 설정: 기본 DDL 방언, 기본컬럼 세트, 기본컬럼 포함 여부 등.',
  },
  'ProjectsController.updateSettings': {
    name: 'project_settings_update',
    description: '프로젝트 설정 변경(프로젝트 관리자).',
  },
  'ProjectsController.copyLog': {
    name: 'project_copy_log',
    description: '프로젝트 생성 때 템플릿·다른 프로젝트에서 복사한 항목 기록(프로젝트 관리자).',
  },
  'ProjectsController.checkKey': {
    name: 'project_key_check',
    description: '새 프로젝트 키 사용 가능 여부(시스템 관리자).',
  },
  'ProjectsController.copySources': {
    name: 'project_copy_sources',
    description: '새 프로젝트를 만들 때 복사 원본으로 고를 수 있는 템플릿·프로젝트 목록.',
  },
  'ProjectsController.preview': {
    name: 'project_copy_preview',
    description: '새 프로젝트 복사 미리보기(항목별 건수, 시스템 관리자).',
  },
  'ProjectsController.create': {
    name: 'project_create',
    description:
      '새 프로젝트 생성(시스템 관리자). 템플릿·프로젝트에서 업무구분·표준 사전을 복사할 수 있다.',
  },
  'MembersController.list': { name: 'members_list', description: '프로젝트 멤버와 역할.' },
  'MembersController.candidates': {
    name: 'member_candidates',
    description: '멤버로 추가할 수 있는 사용자 검색(프로젝트 관리자).',
  },
  'MembersController.add': {
    name: 'member_add',
    description: '멤버 추가·역할 지정(프로젝트 관리자).',
  },
  'MembersController.update': {
    name: 'member_update',
    description: '멤버 역할 변경(프로젝트 관리자).',
  },
  'MembersController.remove': { name: 'member_remove', description: '멤버 제외(프로젝트 관리자).' },

  // ── 업무구분 ──────────────────────────────────────────────────────────
  'BizAreasController.list': {
    name: 'biz_areas_list',
    description:
      '업무구분 목록(bizAreaId·코드·이름·테이블 접두어). 테이블은 반드시 업무구분 하나에 속하고 물리명은 그 접두어로 시작한다.',
  },
  'BizAreasController.create': {
    name: 'biz_area_create',
    description: '업무구분 추가(프로젝트 관리자).',
  },
  'BizAreasController.deletePreview': {
    name: 'biz_area_delete_preview',
    description: '업무구분 삭제 시 함께 지워지는 코드구분·코드 건수(프로젝트 관리자).',
  },
  'BizAreasController.update': {
    name: 'biz_area_update',
    description: '업무구분 수정(테이블이 있으면 코드·접두어·사용 여부는 잠김, 프로젝트 관리자).',
  },
  'BizAreasController.remove': {
    name: 'biz_area_delete',
    description: '업무구분 삭제(테이블 0건일 때만, 프로젝트 관리자).',
  },

  // ── 표준 사전: 검색·용어·승인 ─────────────────────────────────────────
  'SearchController.find': {
    name: 'standards_search',
    description: '표준 사전 통합 검색(용어·도메인·코드). 논리명·물리명 일부로 찾는다.',
  },
  'TermsController.list': {
    name: 'terms_list',
    description:
      '용어 목록(검색·상태 필터·페이지). 상태: APPROVED 승인, PENDING 검토대기, REJECTED 반려.',
  },
  'TermsController.check': {
    name: 'terms_check',
    description: '한글 용어·물리약어 중복 확인. 새 용어를 만들기 전에 부른다.',
  },
  'TermsController.detail': {
    name: 'term_get',
    description: '용어 상세(물리약어·설명·동의어·사용처).',
  },
  'TermsController.create': {
    name: 'term_create',
    description:
      '용어 등록 — 바로 승인(APPROVED) 상태(프로젝트 관리자). 편집자는 term_request를 쓴다. 물리약어는 영대문자·숫자.',
  },
  'TermsController.inline': {
    name: 'term_request',
    description:
      '미등록 용어를 검토대기(PENDING)로 등록(편집자 이상). 등록 즉시 자동완성·테이블 설계에 쓸 수 있고, 프로젝트 관리자가 승인 큐에서 확정한다. 이미 있으면 기존 용어를 돌려준다.',
  },
  'TermsController.update': { name: 'term_update', description: '용어 수정(프로젝트 관리자).' },
  'TermsController.remove': {
    name: 'term_delete',
    description: '용어 삭제(사용 중이면 거부, 프로젝트 관리자).',
  },
  'ApprovalsController.list': {
    name: 'approvals_list',
    description: '승인 대기(PENDING) 용어 목록.',
  },
  'ApprovalsController.count': { name: 'approvals_count', description: '승인 대기 건수.' },
  'ApprovalsController.batch': {
    name: 'approvals_approve_batch',
    description: '검토대기 용어 여러 건 승인(프로젝트 관리자).',
  },
  'ApprovalsController.approve': {
    name: 'approval_approve',
    description: '검토대기 용어 1건 승인. 물리약어·설명을 고쳐 승인할 수 있다(프로젝트 관리자).',
  },
  'ApprovalsController.reject': {
    name: 'approval_reject',
    description: '검토대기 용어 반려(사유 필수, 프로젝트 관리자).',
  },
  'AuditLogsController.list': {
    name: 'standards_audit_logs',
    description: '표준 사전 변경 이력(용어·도메인·코드 등 대상별).',
  },

  // ── 도메인분류·도메인 ─────────────────────────────────────────────────
  'DomainClassesController.list': {
    name: 'domain_classes_list',
    description:
      '도메인분류 목록 — 접미어(예 번호·코드·명·일자)별 기본 타입·길이. 도메인 물리명·타입 계산의 기준.',
  },
  'DomainClassesController.detail': { name: 'domain_class_get', description: '도메인분류 상세.' },
  'DomainClassesController.create': {
    name: 'domain_class_create',
    description: '도메인분류 추가(프로젝트 관리자).',
  },
  'DomainClassesController.update': {
    name: 'domain_class_update',
    description: '도메인분류 수정(프로젝트 관리자).',
  },
  'DomainClassesController.remove': {
    name: 'domain_class_delete',
    description: '도메인분류 삭제(프로젝트 관리자).',
  },
  'DomainsController.list': {
    name: 'domains_list',
    description: '도메인 목록(논리명·물리명·표준 타입, 검토필요 필터).',
  },
  'DomainsController.calculate': {
    name: 'domain_calculate',
    description:
      '도메인 미리 계산 — 명칭 조각 nm1~nm7(등록된 용어, 마지막 조각은 도메인분류 접미어)로 논리명·물리명·타입을 계산하고 미등록 조각·중복을 알려 준다. domain_create 전에 부른다.',
  },
  'DomainsController.recalculate': {
    name: 'domains_recalculate',
    description: '도메인 일괄 재계산(검토필요만 / 자동 타입 전체, 프로젝트 관리자).',
  },
  'DomainsController.detail': {
    name: 'domain_get',
    description: '도메인 상세(조각·타입·사용 컬럼 수).',
  },
  'DomainsController.create': {
    name: 'domain_create',
    description:
      '도메인 등록(프로젝트 관리자). 입력은 domain_calculate와 같다. 조각 용어가 없으면 먼저 term_create/term_request.',
  },
  'DomainsController.update': {
    name: 'domain_update',
    description: '도메인 수정(프로젝트 관리자).',
  },
  'DomainsController.remove': {
    name: 'domain_delete',
    description: '도메인 삭제(사용 중이면 거부, 프로젝트 관리자).',
  },

  // ── 코드·기본컬럼 ─────────────────────────────────────────────────────
  'CodeClassesController.list': {
    name: 'code_classes_list',
    description: '코드구분 목록(업무구분별). `…코드` 컬럼은 코드구분에 연결한다(codeClsId).',
  },
  'CodeClassesController.detail': {
    name: 'code_class_get',
    description: '코드구분 상세와 코드값.',
  },
  'CodeClassesController.create': {
    name: 'code_class_create',
    description: '코드구분 추가(프로젝트 관리자).',
  },
  'CodeClassesController.update': {
    name: 'code_class_update',
    description: '코드구분 수정(프로젝트 관리자).',
  },
  'CodeClassesController.remove': {
    name: 'code_class_delete',
    description: '코드구분 삭제(프로젝트 관리자).',
  },
  'CodeClassesController.codeList': { name: 'codes_list', description: '코드구분의 코드값 목록.' },
  'CodeClassesController.createCode': {
    name: 'code_create',
    description: '코드값 추가(프로젝트 관리자).',
  },
  'CodeClassesController.updateCode': {
    name: 'code_update',
    description: '코드값 수정(프로젝트 관리자).',
  },
  'CodeClassesController.removeCode': {
    name: 'code_delete',
    description: '코드값 삭제(프로젝트 관리자).',
  },
  'DefaultColumnSetsController.list': {
    name: 'default_column_sets_list',
    description: '기본컬럼 세트(등록자·등록일시 같은 공통 감사 컬럼) 목록과 기본 세트 표시.',
  },
  'DefaultColumnSetsController.detail': {
    name: 'default_column_set_get',
    description:
      '기본컬럼 세트 상세(컬럼 정의, defaultColId). 새 테이블 columns 끝에 이 컬럼들을 defaultColId와 함께 넣는다.',
  },
  'DefaultColumnSetsController.create': {
    name: 'default_column_set_create',
    description: '기본컬럼 세트 추가(프로젝트 관리자).',
  },
  'DefaultColumnSetsController.update': {
    name: 'default_column_set_update',
    description: '기본컬럼 세트 이름 등 수정(프로젝트 관리자).',
  },
  'DefaultColumnSetsController.columns': {
    name: 'default_column_set_columns',
    description: '기본컬럼 세트의 컬럼 전체 교체(프로젝트 관리자).',
  },
  'DefaultColumnSetsController.setDefault': {
    name: 'default_column_set_set_default',
    description: '프로젝트 기본 세트로 지정(프로젝트 관리자).',
  },
  'DefaultColumnSetsController.remove': {
    name: 'default_column_set_delete',
    description: '기본컬럼 세트 삭제(프로젝트 관리자).',
  },

  // ── 테이블 설계 ───────────────────────────────────────────────────────
  'AutocompleteController.column': {
    name: 'column_autocomplete',
    description:
      '컬럼 논리명 1개 → 표준 물리명·타입·도메인. type: exact(표준 도메인 일치, applied 사용) / similar(candidates에서 고름) / composed(용어 조각 조합) / unregistered(segments 중 matched=false 조각이 미등록 → term_request 후 다시 호출). "…코드" 이름은 codeCandidates(코드구분)도 준다. 편집자 이상.',
  },
  'AutocompleteController.batch': {
    name: 'columns_autocomplete',
    description:
      '컬럼 논리명 여러 개(최대 200)를 한 번에 표준 물리명·타입·도메인으로 변환. 테이블 설계의 핵심 — 물리명·타입을 직접 지어내지 말고 이 결과를 columns에 옮긴다. 편집자 이상.',
  },
  'AutocompleteController.suggestName': {
    name: 'table_name_suggest',
    description:
      '업무구분 + 테이블 논리명 → 표준 물리 테이블명 제안(접두어 + 용어 약어, 중복 확인). 편집자 이상.',
  },
  'TablesController.tables': {
    name: 'tables_list',
    description:
      '테이블 목록(업무구분·상태·검색 필터, 페이지). 상태: DRAFT 작성중, FINAL 확정(읽기 전용).',
  },
  'TableEditController.detail': {
    name: 'table_get',
    description:
      '테이블 상세(헤더·컬럼·version). 수정할 때는 받은 version을 table_save에 그대로 보낸다.',
  },
  'TableEditController.validate': {
    name: 'table_validate',
    description:
      '테이블 정의를 저장하지 않고 검증 — 물리명 형식·중복·예약어·타입 누락 등 오류(errors)·경고(warnings)를 행 번호와 함께 돌려준다. 저장 전에 부른다.',
  },
  'TableEditController.create': {
    name: 'table_create',
    description:
      '새 테이블 저장(편집자 이상). body = { table: {bizAreaId, tableNm, tableLogicalNm, description}, columns: [...] }. 컬럼은 columns_autocomplete 결과의 applied(physicalNm·dataType·dataLength·dataScale·colComment·domainId·matchType)를 쓰고, 코드 컬럼은 codeClsId·matchType=CODE. 검증 오류가 있으면 422.',
  },
  'TableEditController.save': {
    name: 'table_save',
    description:
      '기존 테이블 전체 저장(편집자 이상). table_get의 version 필수(다른 사람이 먼저 저장했으면 409 충돌 → 다시 읽고 합친다). columns는 전체 목록(빠진 컬럼은 삭제), 기존 컬럼은 columnId 유지.',
  },
  'TableEditController.remove': {
    name: 'table_delete',
    description: '테이블 삭제(편집자 이상, 확정 테이블은 불가).',
  },
  'TableEditController.status': {
    name: 'table_status',
    description: '테이블 상태 변경 DRAFT ↔ FINAL(확정 해제는 프로젝트 관리자). version 필수.',
  },
  'TableEditController.clone': {
    name: 'table_clone',
    description: '테이블 복제(같은 프로젝트 새 이름 또는 다른 프로젝트).',
  },
  'TableEditController.history': {
    name: 'table_history',
    description: '테이블 저장 이력(버전 목록).',
  },
  'TableEditController.historyVersion': {
    name: 'table_history_get',
    description: '테이블 특정 버전 스냅샷.',
  },
  'TableEditController.restore': {
    name: 'table_restore',
    description: '이전 버전으로 복원(새 버전으로 저장, 편집자 이상). body.version = 현재 version.',
  },

  // ── DDL ───────────────────────────────────────────────────────────────
  'TablesController.tableDdl': {
    name: 'table_ddl',
    description: '저장된 테이블 1개의 DDL 텍스트(방언·옵션). format=json이면 경고 목록 포함.',
  },
  'DdlController.generate': {
    name: 'ddl_generate',
    description:
      '여러 테이블 DDL 생성. output=JSON(미리보기·경고) 또는 SQL(텍스트). ZIP은 파일이라 지원하지 않는다.',
  },
  'DdlController.extract': {
    name: 'ddl_extract',
    description: '테이블·컬럼 정의 표(정보 추출). output=JSON 권장(TSV는 텍스트).',
  },
  'DdlController.record': {
    name: 'export_log_record',
    description: '화면 복사 기록 남기기(보통 쓸 일 없음).',
  },
  'DdlController.logs': { name: 'export_logs_list', description: 'DDL 내보내기 기록.' },

  // ── 시스템 관리 ───────────────────────────────────────────────────────
  'AdminProjectsController.list': {
    name: 'admin_projects_list',
    description: '전체 프로젝트 관리 목록(시스템 관리자).',
  },
  'AdminProjectsController.setStatus': {
    name: 'admin_project_status',
    description: '프로젝트 보관·복원(시스템 관리자).',
  },
  'AdminProjectsController.remove': {
    name: 'admin_project_delete',
    description: '프로젝트 삭제(시스템 관리자, 되돌릴 수 없음).',
  },
  'AdminTemplatesController.list': {
    name: 'admin_templates_list',
    description: '표준 템플릿 목록(시스템 관리자).',
  },
  'AdminTemplatesController.publish': {
    name: 'admin_template_publish',
    description: '프로젝트를 템플릿으로 발행(시스템 관리자).',
  },
  'AdminTemplatesController.setStatus': {
    name: 'admin_template_status',
    description: '템플릿 보관·복원(시스템 관리자).',
  },
  'AdminTemplatesController.remove': {
    name: 'admin_template_delete',
    description: '템플릿 삭제(시스템 관리자).',
  },
  'AdminUsersController.list': {
    name: 'admin_users_list',
    description: '사용자 목록(시스템 관리자).',
  },
  'AdminUsersController.create': {
    name: 'admin_user_create',
    description:
      '사용자 추가(시스템 관리자). initialPassword를 생략하면 임시 비밀번호가 응답에 나오므로 웹에서 만드는 것을 권장.',
  },
  'AdminUsersController.get': {
    name: 'admin_user_get',
    description: '사용자 상세(시스템 관리자).',
  },
  'AdminUsersController.update': {
    name: 'admin_user_update',
    description: '사용자 이름·이메일·시스템 관리자 여부 수정(시스템 관리자).',
  },
  'AdminUsersController.setActive': {
    name: 'admin_user_active',
    description: '사용자 활성·비활성(비활성 시 세션·접근 토큰 폐기, 시스템 관리자).',
  },
  'AdminUsersController.unlock': {
    name: 'admin_user_unlock',
    description: '잠긴 계정 해제(시스템 관리자).',
  },
  'AdminCacheController.status': {
    name: 'admin_cache_status',
    description: '자동완성 캐시 상태(시스템 관리자).',
  },
  'AdminCacheController.reload': {
    name: 'admin_cache_reload',
    description: '프로젝트 자동완성 캐시 다시 적재(시스템 관리자).',
  },
};
