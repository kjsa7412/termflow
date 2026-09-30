<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { MEMBER_ROLE_RANK, type BizAreaItem, type TableCloneResponse } from '@termflow/shared';
import { projectsApi } from '../../api/projects.js';
import { tablesApi } from '../../api/tables.js';
import { errMsg } from '../../composables/useProject.js';
import { useSessionStore } from '../../stores/session.js';
import { useToastStore } from '../../stores/toast.js';
import TfButton from '../ui/TfButton.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';

/**
 * 테이블 복제(설계서 §8.4·Q10, T8.14 — 모달 금지, 팝오버). 대상 프로젝트(편집자 이상인 활성 프로젝트) · 업무구분
 * (같은 프로젝트 = 원본, 다른 프로젝트 = 같은 biz_cd 기본) · 이름(비우면 자동: 같은 프로젝트 `_COPY`, 다른 프로젝트 원래 이름).
 * 다른 프로젝트 복제의 재매핑 실패(도메인·코드구분·기본컬럼 NULL)는 결과 알림으로 보여 준다.
 */
const props = defineProps<{
  projectKey: string;
  tableId: number;
  tableNm: string;
  bizCd: string;
}>();
const emit = defineEmits<{ cloned: [r: TableCloneResponse] }>();
const session = useSessionStore();
const papi = projectsApi();
const tapi = tablesApi();
const toast = useToastStore();

const targets = computed(() =>
  session.projects.filter(
    (p) =>
      p.kind === 'PROJECT' &&
      p.status === 'ACTIVE' &&
      (session.isSysAdmin || MEMBER_ROLE_RANK[p.role] >= MEMBER_ROLE_RANK.EDITOR),
  ),
);
const target = ref(props.projectKey);
const bizAreas = ref<BizAreaItem[]>([]);
const bizAreaId = ref<number | null>(null);
const name = ref('');
const busy = ref(false);
const same = computed(() => target.value === props.projectKey);

async function loadBiz(): Promise<void> {
  try {
    bizAreas.value = (await papi.bizAreas(target.value)).filter((b) => b.useYn);
  } catch {
    bizAreas.value = [];
  }
  bizAreaId.value = bizAreas.value.find((b) => b.bizCd === props.bizCd)?.bizAreaId ?? null;
}
watch(target, () => void loadBiz());

async function submit(close: () => void): Promise<void> {
  busy.value = true;
  try {
    const r = await tapi.clone(props.projectKey, props.tableId, {
      ...(same.value ? {} : { targetProjectKey: target.value }),
      ...(bizAreaId.value !== null ? { targetBizAreaId: bizAreaId.value } : {}),
      ...(name.value.trim() ? { tableNm: name.value.trim() } : {}),
    });
    const warn = r.remapWarnings.length;
    if (warn > 0) {
      toast.push(
        `${r.projectKey}/${r.tableNm}(으)로 복제했습니다 — 대상 표준에서 찾지 못한 참조 ${warn}건은 연결을 해제했습니다: ${r.remapWarnings
          .slice(0, 3)
          .map((w) => w.message)
          .join(' · ')}${warn > 3 ? ' …' : ''}`,
        'info',
        8000,
      );
    } else {
      toast.success(`${r.projectKey}/${r.tableNm}(으)로 복제했습니다`);
    }
    close();
    emit('cloned', r);
  } catch (e) {
    toast.error(errMsg(e, '복제하지 못했습니다'));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <TfPopover align="right" popover>
    <template #trigger="{ toggle, open, menuId }">
      <button
        class="btn btn-ghost"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="menuId"
        @click="(toggle(), !open && loadBiz())"
      >
        <TfIcon name="duplicate" />복제
      </button>
    </template>
    <template #default="{ close }">
      <form class="stack w-320" aria-label="테이블 복제" @submit.prevent="submit(close)">
        <div class="popover-title">테이블 복제 — {{ tableNm }}</div>
        <div class="field">
          <label class="field-label" for="cl-target">대상 프로젝트</label>
          <select id="cl-target" v-model="target" class="select select-sm">
            <option v-for="p in targets" :key="p.key" :value="p.key">
              {{ p.key }} {{ p.nm }}{{ p.key === projectKey ? ' (현재)' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="cl-biz">업무구분</label>
          <select id="cl-biz" v-model="bizAreaId" class="select select-sm">
            <option :value="null">{{ same ? '원본과 같게' : `같은 코드(${bizCd}) 자동` }}</option>
            <option v-for="b in bizAreas" :key="b.bizAreaId" :value="b.bizAreaId">
              {{ b.bizCd }} {{ b.bizNm }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="cl-name">물리명</label>
          <input
            id="cl-name"
            v-model="name"
            class="input input-sm mono"
            maxlength="63"
            :placeholder="same ? `${tableNm}_COPY` : tableNm"
          />
          <span class="field-help"
            >비우면 자동({{ same ? '_COPY, _COPY2 …' : '원래 이름, 겹치면 _COPY' }}) ·
            {{ same ? '참조 그대로' : '도메인·코드구분·기본컬럼은 대상 표준에서 다시 찾습니다' }}</span
          >
        </div>
        <TfButton variant="primary" size="sm" icon="duplicate" type="submit" :loading="busy"
          >복제</TfButton
        >
      </form>
    </template>
  </TfPopover>
</template>
