import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchServerState, type ServerState } from '../api/health.js';

export const useServerStore = defineStore('server', () => {
  const state = ref<ServerState | 'checking'>('checking');

  async function refresh(): Promise<void> {
    state.value = 'checking';
    state.value = await fetchServerState();
  }

  return { state, refresh };
});
