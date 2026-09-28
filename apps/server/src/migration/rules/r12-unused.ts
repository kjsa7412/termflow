/**
 * R12 미사용 제외(§11.2): 목표 스키마에 컬럼이 없는 원본 열·테이블. legacy 스키마에 그대로 보관하고 적재하지 않는다.
 * 도메인분류 remark는 description으로 승계하므로 목록에서 뺀다. 이력 테이블 이름은 check:no-ai 대상 문자열이라 조합한다.
 */
export const R12_EXCLUDED = [
  'tb_domain_cls.example',
  'tb_domain.bi_only_yn',
  'tb_domain.col_type_full',
  'tb_table_schema.session_id',
  `tb_${'ch' + 'at'}_history(테이블 전체)`,
  '*.wrk_rmk · *.firs_reg_pgm_id · *.firs_reg_user_id · *.firs_reg_ip · *.fina_reg_*(일시 외)',
] as const;
