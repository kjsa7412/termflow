// 색·간격·글꼴 토큰은 제품과 같은 파일(CR-12 C2). 사이트 배치·어두운 테마는 site.css
import '../../apps/web/src/styles/tokens.css';
import './site.css';
import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
