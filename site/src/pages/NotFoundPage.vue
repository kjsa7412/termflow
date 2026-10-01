<script setup lang="ts">
import { ROUTES } from '../routes.js';
import { route, SiteLink } from '../router.js';
</script>

<template>
  <div class="wrap page">
    <h1 tabindex="-1">없는 주소입니다</h1>
    <p class="lead">
      <span class="mono">{{ route.path }}</span> 는 이 사이트에 없다. 이 사이트의 주소는
      {{ ROUTES.length }}개다.
    </p>
    <ul class="list">
      <li v-for="r in ROUTES" :key="r.path">
        <SiteLink :to="r.path">{{ r.nav ?? '홈' }}</SiteLink> —
        <span class="muted">{{ r.description }}</span>
      </li>
    </ul>
  </div>
</template>
