/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** 빌드 버전(vite.config.ts `define`, 루트 package.json version). */
declare const __APP_VERSION__: string;
