/**
 * 비밀번호 정책·잠금 상수(설계서 §7.6). 서버 검증과 화면 안내가 같은 값을 쓴다.
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 64,
  /** 영문·숫자·특수문자 중 최소 종류 수. */
  minCharClasses: 2,
  /** 연속 실패 잠금 기준·시간(§7.6, 환경 변수 LOCKOUT_MAX·LOCKOUT_MINUTES 기본값). */
  lockoutMaxFailures: 5,
  lockoutMinutes: 15,
  /** 관리자 초기화 임시 비밀번호 길이. */
  temporaryLength: 12,
  /** bcrypt cost(§7.1). */
  bcryptCost: 10,
} as const;

export type PasswordPolicyViolation =
  'PW_LENGTH' | 'PW_CHAR_CLASSES' | 'PW_CONTAINS_LOGIN_ID' | 'PW_SAME_AS_PREVIOUS';

export const PASSWORD_VIOLATION_MESSAGES: Record<PasswordPolicyViolation, string> = {
  PW_LENGTH: `비밀번호는 ${PASSWORD_POLICY.minLength}~${PASSWORD_POLICY.maxLength}자여야 합니다`,
  PW_CHAR_CLASSES: '영문·숫자·특수문자 중 2종류 이상을 섞어 주세요',
  PW_CONTAINS_LOGIN_ID: '비밀번호에 로그인 ID를 포함할 수 없습니다',
  PW_SAME_AS_PREVIOUS: '직전 비밀번호와 같은 비밀번호는 쓸 수 없습니다',
};

/**
 * 형식 규칙 검사. 직전 비밀번호 동일 여부는 해시 비교가 필요하므로 서버가 따로 판정한다
 * (`PW_SAME_AS_PREVIOUS`).
 */
export function checkPasswordPolicy(password: string, loginId: string): PasswordPolicyViolation[] {
  const v: PasswordPolicyViolation[] = [];
  if (password.length < PASSWORD_POLICY.minLength || password.length > PASSWORD_POLICY.maxLength) {
    v.push('PW_LENGTH');
  }
  const classes = [/[A-Za-z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < PASSWORD_POLICY.minCharClasses) v.push('PW_CHAR_CLASSES');
  if (loginId.trim() !== '' && password.toLowerCase().includes(loginId.trim().toLowerCase())) {
    v.push('PW_CONTAINS_LOGIN_ID');
  }
  return v;
}
