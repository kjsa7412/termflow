// ESLint flat config(설계서 §12.2). 스타일은 Prettier가 맡고 eslint-config-prettier로 충돌 규칙을 끈다.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * `sql.raw()` 금지(§12.2): 사용자 입력이 SQL 문자열로 그대로 들어가는 경로를 원천 차단한다.
 * 식별자는 `sql.identifier()`, 값은 `sql` 템플릿 바인딩을 쓴다.
 */
const noSqlRaw = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='raw'][callee.object.name='sql']",
  message:
    'sql.raw()는 금지입니다(§12.2). 값은 sql`...${v}` 바인딩, 식별자는 sql.identifier()를 쓰십시오.',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'seed/**',
      'migration/**',
      'logs/**',
      'apps/server/.drizzle-pull/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      'e2e/.auth/**',
      // db:pull 생성물(BIGINT IDENTITY maxValue 리터럴 정밀도 등 생성 코드 특성, 직접 수정 금지)
      'apps/server/src/db/schema.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    files: ['**/*.{ts,mts,cts,vue,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-syntax': ['error', noSqlRaw],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
    },
  },
  {
    // NestJS DI는 생성자 파라미터 타입의 런타임 값(emitDecoratorMetadata)이 필요하다.
    // type-only import로 바꾸면 주입이 깨지므로 서버 소스에서는 자동 변환 규칙을 끈다.
    files: ['apps/server/src/**/*.ts', 'apps/server/test/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: [
      'apps/server/**/*.{ts,mjs}',
      'packages/shared/**/*.ts',
      'scripts/**/*.{js,mjs}',
      'e2e/**/*.ts',
      '*.{js,mjs,ts}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/src/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser, __APP_VERSION__: 'readonly' } },
    rules: {
      // TS 선택적 prop(`label?: string`)은 undefined가 기본값이다(withDefaults 강제는 소음)
      'vue/require-default-prop': 'off',
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
