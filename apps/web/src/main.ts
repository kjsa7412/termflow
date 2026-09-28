import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { api } from './api/client.js';
import { installAuth } from './auth-wiring.js';
import { createAppRouter } from './router.js';
import { useSessionStore } from './stores/session.js';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
const router = createAppRouter();
installAuth(router, useSessionStore(pinia), api);
app.use(router);
app.mount('#app');
