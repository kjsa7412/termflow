<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  acItems,
  useEditorStore,
  type CellField,
  type EditorRow,
  type RowState,
} from '../../stores/editor.js';
import TfBadge from '../ui/TfBadge.vue';
import TfIcon from '../ui/TfIcon.vue';
import TfPopover from '../ui/TfPopover.vue';
import AcListbox from './AcListbox.vue';
import CodeClsPicker from './CodeClsPicker.vue';
import InlineTermCard from './InlineTermCard.vue';
import SegmentPieces from './SegmentPieces.vue';

/**
 * 컬럼 그리드(설계서 §10.4, 목업 08 `table.grid`, T8.8·T9.7·T9.8). 열 11개: 순서(드래그 핸들) | PK | 논리명 | 물리명 | 타입 | NULL |
 * 기본값 | 코멘트 | 코드구분 | 상태 배지 | 행 메뉴. 행 아래 보조 행(sub-row): 유사·코드 후보 listbox, 조각 배지, 인라인 등록 카드.
 * 키보드(§10.4 표): Enter(논리명) = 자동완성 → 다음 행/새 행(후보·카드가 열리면 머묾) · Enter(listbox) = 선택 ·
 * ↑↓ = listbox 이동(없으면 행 이동) · Esc = listbox·카드 닫기 · Tab/Shift+Tab = 셀 이동 · Alt+↑/↓ = 행 순서 이동 ·
 * Ctrl+V(논리명, 여러 줄) = 행 추가 후 일괄 자동완성 1회.
 * invalid 셀은 빨간 테두리 + 툴팁(서버 검증 메시지 = `codes.ts`), 행 상태 배지는 색 + 텍스트(§10.6).
 */
const props = defineProps<{ readOnly: boolean; canRegisterDomain?: boolean }>();
const emit = defineEmits<{ reapply: [uid: string]; registerDomain: [uid: string] }>();
const ed = useEditorStore();
const root = ref<HTMLElement | null>(null);
const cards = ref<Record<string, InstanceType<typeof InlineTermCard> | null>>({});

// 보이는 폭(--grid-vw): 보조 줄(후보·조각·등록 카드)이 가로 스크롤 영역 밖으로 나가지 않게(CR-15 C9)
let widthWatch: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !root.value) return;
  widthWatch = new ResizeObserver(([e]) => {
    if (e) root.value?.style.setProperty('--grid-vw', `${Math.round(e.contentRect.width)}px`);
  });
  widthWatch.observe(root.value);
});
onBeforeUnmount(() => widthWatch?.disconnect());

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
const listId = (r: EditorRow) => `ac-${r.uid}`;

/** 논리명 Enter 결과로 포커스 이동: 머물면(listbox·카드) 카드는 물리약어 칸, listbox는 논리명 셀 유지. */
async function afterEnter(r: EditorRow, next: EditorRow | null): Promise<void> {
  if (next) return focusCell(next.uid, 'logicalNm');
  await nextTick();
  if (r.ac?.open === 'register') await cards.value[r.uid]?.focus();
  else await focusCell(r.uid, 'logicalNm');
}

async function onKey(e: KeyboardEvent, r: EditorRow, field: TextField): Promise<void> {
  if (props.readOnly) return;
  const i = rowIndexOf(r.uid);
  const listOpen = field === 'logicalNm' && r.ac?.open === 'list' && acItems(r.ac).length > 0;
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (ed.moveRow(r.uid, e.key === 'ArrowUp' ? -1 : 1)) await focusCell(r.uid, field);
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (listOpen) {
      ed.acMove(r.uid, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    const t = ed.rows[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (t) await focusCell(t.uid, field);
    return;
  }
  if (e.key === 'Escape' && field === 'logicalNm' && r.ac?.open) {
    e.preventDefault();
    ed.acClose(r.uid);
    return;
  }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (field === 'logicalNm') {
      await afterEnter(r, await ed.onLogicalEnter(r.uid));
    } else {
      const t = ed.rows[i + 1] ?? ed.addRow(r.uid);
      await focusCell(t.uid, field);
    }
  }
}

async function choose(r: EditorRow, index: number): Promise<void> {
  if (ed.acChoose(r.uid, index)) await focusCell(ed.nextRow(r.uid).uid, 'logicalNm');
}

async function submitRegister(r: EditorRow): Promise<void> {
  if (!ed.registerTerm) return;
  const ok = await ed.registerTerm(r);
  const row = ed.find(r.uid);
  if (ok && row && !row.ac?.open) await focusCell(ed.nextRow(r.uid).uid, 'logicalNm');
  else if (row?.ac?.open === 'register') await cards.value[r.uid]?.focus();
  else if (row) await focusCell(r.uid, 'logicalNm');
}
async function cancelRegister(r: EditorRow): Promise<void> {
  ed.acClose(r.uid);
  await focusCell(r.uid, 'physicalNm');
}

/** Ctrl+V 여러 줄(엑셀 열 복사) → 행 채움 → batch 1회(T9.8). 한 줄이면 브라우저 기본 붙여넣기. */
async function onPaste(e: ClipboardEvent, r: EditorRow): Promise<void> {
  if (props.readOnly) return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.split('\t')[0]!.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return;
  e.preventDefault();
  const filled = ed.pasteLogical(r.uid, lines);
  if (filled.length > 0 && ed.batchAutocomplete) await ed.batchAutocomplete(filled);
  const last = filled.at(-1);
  if (last) await focusCell(last.uid, 'logicalNm');
}

function input(r: EditorRow, field: CellField, e: Event): void {
  const t = e.target as HTMLInputElement;
  // 물리명은 입력하는 대로 대문자(저장 때만 바뀌어 소문자가 그대로 보였다, CR-15 C15). IME 조합 중에는 건드리지 않는다
  if (
    field === 'physicalNm' &&
    !(e as InputEvent).isComposing &&
    t.value !== t.value.toUpperCase()
  ) {
    const [s, en] = [t.selectionStart, t.selectionEnd];
    t.value = t.value.toUpperCase();
    if (s !== null && en !== null) t.setSelectionRange(s, en);
  }
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
const badgeText = (r: EditorRow) => {
  const b = BADGE[r.state];
  if (!b) return '';
  if (r.state === 'similar' && r.ac) return `유사 후보 ${r.ac.candidates.length}`;
  return b.text;
};
const rowClass = (r: EditorRow) => {
  const s = ed.displayState(r);
  return {
    'is-active': r.ac?.open != null,
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
/** [재적용](§4.8): 표준이 바뀌었거나(W_TERM_CHANGED) 도메인 타입이 다르면(W_DOMAIN_TYPE_CHANGED) 같은 논리명으로 다시 자동완성. */
const canReapply = (r: EditorRow) =>
  !props.readOnly &&
  r.defaultColId === null &&
  rowWarnings(r).some((w) => w.code === 'W_TERM_CHANGED' || w.code === 'W_DOMAIN_TYPE_CHANGED');
/** 보조 행: listbox 열림 · 등록 카드 · 이번 세션 자동완성의 조각 배지(composed·unregistered). */
const subRow = (r: EditorRow) =>
  r.ac !== null &&
  (r.ac.open !== null ||
    ((r.state === 'composed' || r.state === 'unregistered') && r.ac.segments.length > 0));
const suffixNote = (r: EditorRow) =>
  r.typeText ? `타입 ${r.typeText}` : '접미어 타입 없음 — 타입을 지정하세요';
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
          <th class="c-status sticky-r">상태</th>
          <th class="c-menu sticky-r"><span class="sr-only">행 메뉴</span></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="(r, i) in ed.rows" :key="r.uid">
          <tr
            :class="rowClass(r)"
            :data-row="i + 1"
            :data-state="r.state"
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
                  f === 'logicalNm'
                    ? '논리명 입력 후 Enter'
                    : f === 'typeText'
                      ? 'VARCHAR(20)'
                      : r.state === 'similar'
                        ? '후보 선택 중'
                        : '—'
                "
                :aria-label="`${i + 1}행 ${LABEL[f]}`"
                :aria-invalid="err(r, f) ? 'true' : undefined"
                :aria-expanded="f === 'logicalNm' ? r.ac?.open === 'list' : undefined"
                :aria-controls="f === 'logicalNm' && r.ac?.open === 'list' ? listId(r) : undefined"
                :aria-activedescendant="
                  f === 'logicalNm' && r.ac?.open === 'list'
                    ? `${listId(r)}-o${r.ac.focus}`
                    : undefined
                "
                :role="f === 'logicalNm' ? 'combobox' : undefined"
                :aria-autocomplete="f === 'logicalNm' ? 'list' : undefined"
                :title="err(r, f)?.message"
                :data-field="f"
                :data-uid="r.uid"
                autocomplete="off"
                spellcheck="false"
                @input="input(r, f, $event)"
                @keydown="onKey($event, r, f)"
                @paste="f === 'logicalNm' ? onPaste($event, r) : undefined"
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
              <CodeClsPicker :row="r" :read-only="readOnly" :row-no="i + 1" />
            </td>
            <td class="c-status sticky-r">
              <span class="cell-status" :data-state="ed.displayState(r)">
                <span v-if="r.state === 'loading'" class="text-sm text-muted" role="status"
                  ><span class="spinner" aria-hidden="true" /> 자동완성 중</span
                >
                <TfBadge
                  v-else-if="rowErrors(r).length > 0"
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
                  >{{ badgeText(r) }}</TfBadge
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
                <span v-if="r.acError" class="text-sm text-danger" role="alert">{{
                  r.acError
                }}</span>
                <button
                  v-if="canReapply(r)"
                  class="btn-link"
                  type="button"
                  title="바뀐 표준으로 물리명·타입을 다시 채웁니다"
                  data-testid="reapply"
                  @click="emit('reapply', r.uid)"
                >
                  재적용
                </button>
                <!-- 표준 사전에 바로 쓰이므로 한 번 확인(CR-15 C15) -->
                <TfPopover
                  v-if="canRegisterDomain && !readOnly && r.state === 'composed'"
                  popover
                  align="right"
                >
                  <template #trigger="{ toggle, open, menuId }">
                    <button
                      class="btn-link"
                      type="button"
                      title="조합 결과를 이 프로젝트의 표준 도메인으로 등록"
                      aria-haspopup="dialog"
                      :aria-expanded="open"
                      :aria-controls="menuId"
                      data-testid="register-domain"
                      @click="toggle"
                    >
                      도메인으로 등록
                    </button>
                  </template>
                  <template #default="{ close }">
                    <div class="popover-title">표준 도메인으로 등록할까요?</div>
                    <p class="text-sm text-2">
                      {{ r.logicalNm }} → <span class="mono">{{ r.physicalNm }}</span>
                      {{ r.typeText }}<br />이 프로젝트의 표준 사전(도메인)에 추가되고 이 행은
                      '표준'이 됩니다.
                    </p>
                    <div class="row mt-3">
                      <button
                        class="btn btn-primary btn-sm"
                        type="button"
                        data-testid="register-domain-confirm"
                        @click="(close(), emit('registerDomain', r.uid))"
                      >
                        등록
                      </button>
                      <button class="btn btn-ghost btn-sm" type="button" @click="close()">
                        취소
                      </button>
                    </div>
                  </template>
                </TfPopover>
              </span>
            </td>
            <td class="c-menu sticky-r">
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
          <tr v-if="subRow(r)" class="sub-row" :data-sub-row="i + 1">
            <td colspan="11">
              <div class="sub-inner">
                <AcListbox
                  v-if="r.ac!.open === 'list'"
                  :row="r"
                  :list-id="listId(r)"
                  @choose="choose(r, $event)"
                />
                <div
                  v-else-if="r.state === 'composed' || r.state === 'unregistered'"
                  class="pieces-line"
                >
                  <span>{{ r.state === 'composed' ? '분절 조합' : '분절 결과' }}</span>
                  <SegmentPieces
                    :segments="r.ac!.segments"
                    :result="r.state === 'composed' ? r.physicalNm : null"
                  />
                  <span v-if="r.state === 'composed'"
                    >{{ suffixNote(r) }} · 다음 행으로 이동하면 그대로 확정됩니다</span
                  >
                  <span v-if="r.state === 'composed' && r.ac!.alternatives.length > 0"
                    >· 다른 분절: {{ r.ac!.alternatives.map((a) => a.physicalNm).join(', ') }}</span
                  >
                </div>
                <InlineTermCard
                  v-if="r.ac!.open === 'register'"
                  :ref="(c) => (cards[r.uid] = c as InstanceType<typeof InlineTermCard> | null)"
                  :row="r"
                  @submit="submitRegister(r)"
                  @cancel="cancelRegister(r)"
                />
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
