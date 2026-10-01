/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** 빌드 버전(vite.config.ts `define`, 루트 package.json version). */
declare const __APP_VERSION__: string;

/** 제품 내 설명서(빌드 시 docs/*.md → HTML, build/manual.ts, T12.5). */
declare module 'virtual:termflow-manual' {
  export interface ManualBook {
    id: string;
    title: string;
    audience: 'all' | 'sysadmin';
    icon: string;
    desc: string;
    toc: { level: 2 | 3; slug: string; text: string }[];
    html: string;
  }
  const books: ManualBook[];
  export default books;
}
