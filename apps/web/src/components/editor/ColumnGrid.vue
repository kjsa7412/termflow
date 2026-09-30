<script setup lang="ts">
import { nextTick, ref } from 'vue';
import {
  useEditorStore,
  type CellField,
  type EditorRow,
  type RowState,
} from '../../stores/editor.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';

/**
 * 컬럼 그리드(설계서 §10.4, 목업 08 `table.grid`, T8.8). 열 11개: 순서(드래그 핸들) | PK | 논리명 | 물리명 | 타입 | NULL |
 * 기본값 | 코멘트 | 코드구분 | 상태 배지 | 행 메뉴.
 * 키보드(§10.4 표): Tab/Shift+Tab = 셀 이동(브라우저 기본, 행 끝에서 다음 행 첫 셀) · Enter = 다음 행 같은 열(논리명 셀은
 * `onLogicalEnter` — 마지막 행이면 새 행, T9.7에서 자동완성이 붙는 자리) · ↑/↓ = 위아래 행 같은 열 · Alt+↑/↓ = 행 순서 이동.
 * invalid 셀은 빨간 테두리 + 툴팁(서버 검증 메시지 = `codes.ts`), 행 상태 배지는 색 + 텍스트(§10.6).
 */
const props = defineProps<{ readOnly: boolean }>();
const ed = useEditorStore();
const root = ref<HTMLElement | null>(null);

type TextField = Extract<
  CellField,
  'logicalNm' | 'physicalNm' | 'typeText' | 'defaultVal' | 'colComment'
>;
const TEXT_FIELDS: TextField[] = [
  'logicalNm',
  'physicalNm',
  'typeText',
  'defaultVal',
  'colComment',
];
const LABEL: Record<TextField, string> = {
  logicalNm: '논리명',
  physicalNm: '물리명',
  typeText: '타입',
  defaultVal: '기본값',
  colComment: '코멘트',
};

async function focusCell(uid: string, field: string = 'logicalNm'): Promise<void> {
  await nextTick();
  const f =
    field === 'dataType' || field === 'dataLength' || field === 'dataScale' ? 'typeText' : field;
  const el =
    root.value?.querySelector<HTMLElement>(`[data-uid="${uid}"][data-field="${f}"]`) ??
    root.value?.querySelector<HTMLElement>(`[data-uid="${uid}"][data-field="logicalNm"]`);
  el?.focus();
  el?.scrollIntoView?.({ block: 'nearest' });
}
defineExpose({ focusCell });

const rowIndexOf = (uid: string) => ed.rows.findIndex((r) => r.uid === uid);

async function onKey(e: KeyboardEvent, r: EditorRow, field: TextField): Promise<void> {
  if (props.readOnly) return;
  const i = rowIndexOf(r.uid);
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (ed.moveRow(r.uid, e.key === 'ArrowUp' ? -1 : 1)) await focusCell(r.uid, field);
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const t = ed.rows[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (t) {
      e.preventDefault();
      await focusCell(t.uid, field);
    }
    return;
  }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (field === 'logicalNm') {
      const next = await ed.onLogicalEnter(r.uid);
      await focusCell(next.uid, 'logicalNm');
    } else {
      const t = ed.rows[i + 1] ?? ed.addRow(r.uid);
      await focusCell(t.uid, field);
    }
  }
}

function input(r: EditorRow, field: CellField, e: Event): void {
  const t = e.target as HTMLInputElement;
  ed.setCell(r.uid, field, t.type === 'checkbox' ? t.checked : t.value);
}

// ── 드래그 순서 변경(Alt+↑↓가 키보드 대안) ─────────────────────────
const dragging = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
function onDragStart(e: DragEvent, r: EditorRow): void {
  if (props.readOnly) return;
  dragging.value = r.uid;
  e.dataTransfer?.setData('text/plain', r.uid);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e: DragEvent, r: EditorRow): void {
  if (!dragging.value) return;
  e.preventDefault();
  dropTarget.value = r.uid;
}
function onDrop(e: DragEvent, r: EditorRow): void {
  e.preventDefault();
  const from = dragging.value ?? e.dataTransfer?.getData('text/plain') ?? null;
  if (from) ed.moveRowTo(from, r.uid);
  dragging.value = null;
  dropTarget.value = null;
}
function onDragEnd(): void {
  dragging.value = null;
  dropTarget.value = null;
}

// ── 표시 ─────────────────────────────────────────────────────────
type BadgeKind = 'std' | 'composed' | 'unreg' | 'code' | 'default' | 'gray' | 'outline';
const BADGE: Record<RowState, { kind: BadgeKind; text: string } | null> = {
  idle: null,
  loading: null,
  manual: { kind: 'gray', text: '수동' },
  default: { kind: 'default', text: '기본컬럼' },
  exact: { kind: 'std', text: '표준' },
  similar: { kind: 'outline', text: '유사 후보' },
  composed: { kind: 'composed', text: '표준 도메인 아님' },
  unregistered: { kind: 'unreg', text: '미등록' },
  code: { kind: 'code', text: '코드' },
};
const rowClass = (r: EditorRow) => {
  const s = ed.displayState(r);
  return {
    'is-error': s === 'invalid',
    'is-warn': s !== 'invalid' && ed.issuesOf(r.uid).some((i) => i.severity === 'W'),
    'is-unreg': s === 'unregistered',
    'is-composed': s === 'composed',
    'is-new': r.state === 'idle' && r.logicalNm === '',
    'is-dragging': dragging.value === r.uid,
    'is-drop-target': dropTarget.value === r.uid && dragging.value !== r.uid,
  };
};
const err = (r: EditorRow, f: string) => ed.fieldError(r.uid, f);
const rowWarnings = (r: EditorRow) => ed.issuesOf(r.uid).filter((i) => i.severity === 'W');
const rowErrors = (r: EditorRow) => ed.issuesOf(r.uid).filter((i) => i.severity === 'E');
const codeText = (r: EditorRow) =>
  r.codeCls
    ? `${r.codeCls.bizCd}/${r.codeCls.codeCls} ${r.codeCls.codeClsNm}`
    : r.codeClsId !== null
      ? `#${r.codeClsId}`
      : null;
</script>

<template>
  <div ref="root" class="grid-wrap">
    <table class="grid" aria-label="컬럼 목록" data-testid="column-grid">
      <thead>
        <tr>
          <th class="c-drag sticky-l">순서</th>
          <th class="c-pk sticky-l">PK</th>
          <th class="c-logical sticky-l">논리명</th>
          <th class="c-phys">물리명</th>
          <th class="c-type">타입</th>
          <th class="c-null">NULL</th>
          <th class="c-def">기본값</th>
          <th class="c-comment">코멘트</th>
          <th class="c-code">코드구분</th>
          <th class="c-status">상태</th>
          <th class="c-menu"><span class="sr-only">행 메뉴</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(r, i) in ed.rows"
          :key="r.uid"
          :class="rowClass(r)"
          :data-row="i + 1"
          @dragover="onDragOver($event, r)"
          @drop="onDrop($event, r)"
        >
          <td class="c-drag sticky-l">
            <span class="drag-cell"
              ><span
                class="drag-handle"
                :draggable="!readOnly"
                title="드래그하여 순서 변경 (Alt+↑/↓)"
                @dragstart="onDragStart($event, r)"
                @dragend="onDragEnd"
                ><TfIcon name="grip" /></span
              ><span class="row-index">{{ i + 1 }}</span></span
            >
          </td>
          <td class="c-pk sticky-l">
            <label class="check" title="PK"
              ><input
                type="checkbox"
                :checked="r.isPk"
                :disabled="readOnly"
                :aria-label="`${i + 1}행 PK`"
                data-field="isPk"
                :data-uid="r.uid"
                @change="input(r, 'isPk', $event)" /><span class="check-box" aria-hidden="true"
            /></label>
          </td>
          <td
            v-for="f in TEXT_FIELDS.slice(0, 3)"
            :key="f"
            :class="
              f === 'logicalNm' ? 'c-logical sticky-l' : f === 'physicalNm' ? 'c-phys' : 'c-type'
            "
          >
            <input
              :class="['cell-input', { mono: f !== 'logicalNm', 'is-invalid': err(r, f) }]"
              :value="r[f]"
              :readonly="readOnly"
              :placeholder="
                f === 'logicalNm' ? '논리명 입력' : f === 'typeText' ? 'VARCHAR(20)' : '—'
              "
              :aria-label="`${i + 1}행 ${LABEL[f]}`"
              :aria-invalid="err(r, f) ? 'true' : undefined"
              :title="err(r, f)?.message"
              :data-field="f"
              :data-uid="r.uid"
              autocomplete="off"
              spellcheck="false"
              @input="input(r, f, $event)"
              @keydown="onKey($event, r, f)"
            />
          </td>
          <td class="c-null">
            <label class="check" title="NULL 허용"
              ><input
                type="checkbox"
                :checked="r.isNullable"
                :disabled="readOnly || r.isPk"
                :aria-label="`${i + 1}행 NULL 허용`"
                data-field="isNullable"
                :data-uid="r.uid"
                @change="input(r, 'isNullable', $event)" /><span
                class="check-box"
                aria-hidden="true"
            /></label>
          </td>
          <td
            v-for="f in TEXT_FIELDS.slice(3)"
            :key="f"
            :class="f === 'defaultVal' ? 'c-def' : 'c-comment'"
          >
            <input
              :class="['cell-input', { mono: f === 'defaultVal', 'is-invalid': err(r, f) }]"
              :value="r[f]"
              :readonly="readOnly"
              :placeholder="f === 'colComment' ? '(논리명 사용)' : '—'"
              :aria-label="`${i + 1}행 ${LABEL[f]}`"
              :title="err(r, f)?.message"
              :data-field="f"
              :data-uid="r.uid"
              autocomplete="off"
              @input="input(r, f, $event)"
              @keydown="onKey($event, r, f)"
            />
          </td>
          <td class="c-code">
            <!-- T9.7: 코드구분 인라인 검색 팝오버(§5.6 행 '코드' 아이콘)가 붙는 자리 -->
            <span v-if="codeText(r)" class="code-chip" :title="codeText(r) ?? ''"
              ><TfIcon name="code" size="sm" /><span>{{ codeText(r) }}</span></span
            >
            <span v-else class="cell-text text-muted">—</span>
          </td>
          <td class="c-status">
            <span class="cell-status" :data-state="ed.displayState(r)">
              <TfBadge
                v-if="rowErrors(r).length > 0"
                kind="danger"
                icon="alert-circle"
                :title="
                  rowErrors(r)
                    .map((x) => x.message)
                    .join('\n')
                "
                >{{
                  rowErrors(r).length === 1
                    ? rowErrors(r)[0]!.message
                    : `오류 ${rowErrors(r).length}`
                }}</TfBadge
              >
              <TfBadge
                v-else-if="BADGE[r.state]"
                :kind="BADGE[r.state]!.kind"
                :title="r.domainNm ?? undefined"
                >{{ BADGE[r.state]!.text }}</TfBadge
              >
              <span v-else class="text-sm text-muted">입력 대기</span>
              <TfBadge
                v-if="rowWarnings(r).length > 0"
                kind="warning"
                icon="alert-triangle"
                :title="
                  rowWarnings(r)
                    .map((x) => x.message)
                    .join('\n')
                "
                >경고 {{ rowWarnings(r).length }}</TfBadge
              >
            </span>
          </td>
          <td class="c-menu">
            <TfPopover v-if="!readOnly" align="right">
              <template #trigger="{ toggle, open, menuId }">
                <button
                  class="btn btn-ghost btn-sm btn-icon cell-menu"
                  type="button"
                  :aria-label="`${i + 1}행 메뉴`"
                  aria-haspopup="menu"
                  :aria-expanded="open"
                  :aria-controls="menuId"
                  @click="toggle"
                >
                  <TfIcon name="more" />
                </button>
              </template>
              <template #default="{ close }">
                <button
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(ed.duplicateRow(r.uid), close())"
                >
                  <TfIcon name="duplicate" />행 복제
                </button>
                <button
                  class="dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="(focusCell(ed.insertAbove(r.uid).uid), close())"
                >
                  <TfIcon name="plus" />위에 행 삽입
                </button>
                <div class="dropdown-sep" />
                <button
                  class="dropdown-item is-danger"
                  type="button"
                  role="menuitem"
                  @click="(ed.removeRow(r.uid), close())"
                >
                  <TfIcon name="trash" />행 삭제
                </button>
              </template>
            </TfPopover>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
