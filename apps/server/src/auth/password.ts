import { randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PASSWORD_POLICY, checkPasswordPolicy } from '@termflow/shared';

/** bcrypt(cost 10, §7.1). 평문은 로그·감사에 남기지 않는다. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_POLICY.bcryptCost);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * 존재하지 않는 아이디·비활성 계정도 같은 시간이 걸리도록 비교에 쓰는 더미 해시(응답 시간으로 계정 존재를 추측하지 못하게).
 * 값 자체는 의미 없는 임의 문자열의 해시다.
 */
let dummyHash: Promise<string> | undefined;
export function dummyCompare(plain: string): Promise<boolean> {
  dummyHash ??= bcrypt.hash('termflow-dummy-password-for-timing', PASSWORD_POLICY.bcryptCost);
  return dummyHash.then((h) => bcrypt.compare(plain, h)).then(() => false);
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '!@#$%*-_';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

/**
 * 임시 비밀번호(12자, §7.6 관리자 초기화). 혼동 문자(0/O, 1/l/I)를 빼고 영문 대·소문자·숫자·기호를 1자 이상 섞는다.
 * `crypto.randomInt`(CSPRNG). 로그인 ID를 포함하면 다시 만든다.
 */
export function generateTemporaryPassword(
  loginId = '',
  length = PASSWORD_POLICY.temporaryLength,
): string {
  for (;;) {
    const chars = [LOWER, UPPER, DIGIT, SYMBOL].map((set) => set[randomInt(set.length)]!);
    while (chars.length < length) chars.push(ALL[randomInt(ALL.length)]!);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    const pw = chars.join('');
    if (checkPasswordPolicy(pw, loginId).length === 0) return pw;
  }
}
