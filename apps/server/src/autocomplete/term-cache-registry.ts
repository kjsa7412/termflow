import { Injectable } from '@nestjs/common';

/**
 * 프로젝트별 자동완성 캐시 레지스트리(설계서 §5.1, CR-01 3절: 프로젝트 단위 지연 로드·LRU·무효화).
 * 단계 5는 **호출점만** 고정한다(T5.7): 표준·업무구분 쓰기가 커밋된 뒤 `invalidate(projectId)`를 부른다.
 * 실제 인덱스·LRU는 T9.1에서 이 클래스 안에 구현한다(호출 쪽은 바뀌지 않는다).
 */
@Injectable()
export class TermCacheRegistry {
  /** 호출 기록(진단·테스트용). 단계 9 구현 전에는 아무것도 캐시하지 않는다. */
  private readonly invalidated: number[] = [];

  invalidate(projectId: number): void {
    this.invalidated.push(projectId);
    if (this.invalidated.length > 100) this.invalidated.shift();
  }

  /** 최근 무효화 요청(가장 최근이 끝). */
  recentInvalidations(): readonly number[] {
    return this.invalidated;
  }
}
