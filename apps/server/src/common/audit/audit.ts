import { SYSTEM_ACTORS } from '@termflow/shared';

/**
 * 감사 주체(설계서 §8.6). 서비스 메서드가 인자로 받아 DB 접근 계층까지 명시 전달한다.
 * 요청 스코프에서는 AuditContext.current()가 만들고, 부트스트랩·승계 러너는 시스템 주체를 쓴다.
 */
export interface Audit {
  readonly actor: string;
  readonly ip: string | null;
}

/** tf_user.login_id·감사 컬럼 VARCHAR(50), IP VARCHAR(45). */
const ACTOR_MAX = 50;
const IP_MAX = 45;

export function audit(actor: string, ip: string | null = null): Audit {
  const a = actor.trim();
  if (a === '') throw new Error('감사 주체가 비어 있습니다');
  return Object.freeze({ actor: a.slice(0, ACTOR_MAX), ip: ip ? ip.slice(0, IP_MAX) : null });
}

/** 초기 관리자 부트스트랩 등(§7.5). */
export const SYSTEM_AUDIT: Audit = audit(SYSTEM_ACTORS.SYSTEM);
/** 승계 러너(§11.1: 모든 행 created_by/updated_by='MIGRATION'). */
export const MIGRATION_AUDIT: Audit = audit(SYSTEM_ACTORS.MIGRATION);

/**
 * 요청의 클라이언트 IP: `X-Forwarded-For` 첫 값(사내 리버스 프록시 뒤) → 원격 주소.
 * IPv4-mapped IPv6(`::ffff:1.2.3.4`)는 IPv4로 줄인다.
 */
export function clientIp(req: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined };
}): string | null {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  const raw = first || req.ip || req.socket?.remoteAddress || null;
  if (!raw) return null;
  return raw.replace(/^::ffff:/, '').slice(0, IP_MAX);
}
