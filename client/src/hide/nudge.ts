import { OUTLINE_REVEAL_2_MS, OUTLINE_REVEAL_3_MS } from 'shared/protocol';

export type NudgeLevel = 'danger' | 'warn' | 'info' | 'safe';

export interface ColorNudge {
  level: NudgeLevel;
  text: string;
}

const REVEAL_2_SEC = OUTLINE_REVEAL_2_MS / 1000;
const REVEAL_3_SEC = OUTLINE_REVEAL_3_MS / 1000;

// Mirrors outlineAlpha's edge-case rule (shared/src/stickman.ts): a negative
// or non-integer count is not a real distinctColorCount output, so it's
// treated like the <=1 bucket rather than guessing a level.
export function colorNudge(colorCount: number): ColorNudge {
  if (colorCount === 0) {
    return { level: 'danger', text: '아직 색이 없어요 — 배경에서 색을 뽑아 칠해요!' };
  }
  if (colorCount <= 1 || !Number.isInteger(colorCount)) {
    return { level: 'danger', text: '색 1개는 술래에게 바로 보여요 — 색을 더 섞어요!' };
  }
  if (colorCount === 2) {
    return { level: 'warn', text: `마지막 ${REVEAL_2_SEC}초에 테두리가 드러나요 — 색 하나 더!` };
  }
  if (colorCount === 3) {
    return { level: 'info', text: `마지막 ${REVEAL_3_SEC}초에 테두리가 드러나요` };
  }
  return { level: 'safe', text: '완벽 위장 — 테두리 없음' };
}
