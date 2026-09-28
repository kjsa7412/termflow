import { HEALTH_STATUS, type HealthStatus } from '@termflow/shared';

export type ServerState = HealthStatus | 'unreachable';

/** `/health` 응답 본문을 화면 상태로 바꾼다. 형식이 맞지 않으면 error. */
export function toServerState(body: unknown): ServerState {
  if (typeof body === 'object' && body !== null && 'status' in body) {
    const status = (body as { status: unknown }).status;
    const known = Object.values(HEALTH_STATUS) as string[];
    if (typeof status === 'string' && known.includes(status)) {
      return status as HealthStatus;
    }
  }
  return HEALTH_STATUS.ERROR;
}

export async function fetchServerState(fetchImpl: typeof fetch = fetch): Promise<ServerState> {
  try {
    const res = await fetchImpl('/health', { headers: { Accept: 'application/json' } });
    // terminus는 비정상일 때 503 + 같은 형식 본문을 준다.
    return toServerState(await res.json());
  } catch {
    return 'unreachable';
  }
}
