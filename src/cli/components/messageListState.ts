export interface ViewportState {
  scrollTop: number;          // 顶部消息索引
  visible: number;            // 当前可见条数
}

const VISIBLE_CAP = 30;

export function selectVisible<T>(messages: T[], scrollTop: number): T[] {
  if (messages.length <= VISIBLE_CAP) return messages;
  return messages.slice(scrollTop, scrollTop + VISIBLE_CAP);
}

export function clampScrollTop(scrollTop: number, total: number): number {
  if (total <= VISIBLE_CAP) return 0;
  const maxScroll = total - VISIBLE_CAP;
  if (scrollTop < 0) return 0;
  if (scrollTop > maxScroll) return maxScroll;
  return scrollTop;
}
