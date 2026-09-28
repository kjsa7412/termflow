<script setup lang="ts">
import { APP_NAME } from '@termflow/shared';
import { onMounted } from 'vue';
import { useServerStore } from '../stores/server.js';

const server = useServerStore();

onMounted(() => {
  void server.refresh();
});
</script>

<template>
  <main class="home">
    <h1 data-testid="server-status">{{ APP_NAME }} · server {{ server.state }}</h1>
    <button type="button" @click="server.refresh()">다시 확인</button>
  </main>
</template>

<style scoped>
.home {
  font-family: system-ui, sans-serif;
  padding: 2rem;
}
</style>
