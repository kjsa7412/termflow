<script setup lang="ts">
import { ref } from 'vue';

/** 명령 상자 — [복사] 단추. 줄 앞 `#`는 설명 줄로 흐리게. */
const props = defineProps<{ code: string; label?: string }>();
const copied = ref(false);
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code.trim());
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 권한 없음 — 직접 선택해 복사 */
  }
}
</script>

<template>
  <div class="code">
    <div class="code__head">
      <span>{{ label ?? 'bash' }}</span>
      <button type="button" class="code__copy" @click="copy">
        {{ copied ? '복사됨' : '복사' }}
      </button>
    </div>
    <pre><code><template v-for="(line, i) in code.trim().split('\n')" :key="i"><span :class="{ 'code__cm': line.trimStart().startsWith('#') }">{{ line }}</span>{{ '\n' }}</template></code></pre>
  </div>
</template>
