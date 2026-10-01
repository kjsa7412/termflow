/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** 제품 판(루트 package.json version, vite.config.ts `define`). */
declare const __TF_VERSION__: string;
/** 배포 base(`/` 또는 `TERMFLOW_SITE_BASE`). */
declare const __TF_BASE__: string;
