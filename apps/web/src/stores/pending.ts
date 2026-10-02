import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 검토대기 용어 수가 바뀌었다는 신호(CR-15 C16). 사이드바 [승인 큐] 배지는 30초마다 다시 세는데, 승인·반려·인라인 등록 직후에는
 * 이 신호로 바로 다시 센다(전에는 승인 뒤에도 최대 30초 동안 옛 숫자가 남았다).
 */
export const usePendingStore = defineStore('pending', () => {
  const tick = ref(0);
  return {
    tick,
    changed: () => {
      tick.value++;
    },
  };
});
