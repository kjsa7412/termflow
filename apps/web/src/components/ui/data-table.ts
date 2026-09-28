/** 목록 페이지 크기(§10.3 "페이지네이션(20/50/100)"). */
export const PAGE_SIZES = [20, 50, 100] as const;

export interface Column {
  key: string;
  label: string;
  sortable?: boolean;
  class?: string;
}

export interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}
