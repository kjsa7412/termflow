/**
 * R13 감사 주체(§11.2): created_by/updated_by='MIGRATION'(MIGRATION_AUDIT), 일시는 원본 `firs_reg_dts/fina_reg_dts`.
 * 원본이 NULL이면 DB 기본값(CURRENT_TIMESTAMP)에 맡긴다. 최종 일시가 없으면 최초 일시를 쓴다.
 */
export interface MigratedTimes {
  createdAt?: string;
  updatedAt?: string;
}

export function migratedTimes(firsRegDts: string | null, finaRegDts: string | null): MigratedTimes {
  const created = firsRegDts ?? undefined;
  const updated = finaRegDts ?? firsRegDts ?? undefined;
  return {
    ...(created !== undefined ? { createdAt: created } : {}),
    ...(updated !== undefined ? { updatedAt: updated } : {}),
  };
}
