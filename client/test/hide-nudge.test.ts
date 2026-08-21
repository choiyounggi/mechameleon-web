import { describe, expect, it } from 'vitest';
import { OUTLINE_REVEAL_2_MS, OUTLINE_REVEAL_3_MS } from 'shared/protocol';
import { colorNudge } from '../src/hide/nudge';

describe('colorNudge: pre-confirm color-mixing guidance (D1)', () => {
  it('0 colors: danger level with the 0-color-specific empty-canvas text (boundary)', () => {
    const nudge = colorNudge(0);
    expect(nudge.level).toBe('danger');
    expect(nudge.text).toBe('아직 색이 없어요 — 배경에서 색을 뽑아 칠해요!');
  });

  it('1 color: danger level, warning that a single color is instantly visible (normal)', () => {
    const nudge = colorNudge(1);
    expect(nudge.level).toBe('danger');
    expect(nudge.text).toBe('색 1개는 술래에게 바로 보여요 — 색을 더 섞어요!');
  });

  it('2 colors: warn level, text derives its seconds from OUTLINE_REVEAL_2_MS not a hardcoded 60 (normal)', () => {
    const nudge = colorNudge(2);
    expect(nudge.level).toBe('warn');
    expect(nudge.text).toContain(`${OUTLINE_REVEAL_2_MS / 1000}`);
  });

  it('3 colors: info level, text derives its seconds from OUTLINE_REVEAL_3_MS not a hardcoded 30 (normal)', () => {
    const nudge = colorNudge(3);
    expect(nudge.level).toBe('info');
    expect(nudge.text).toContain(`${OUTLINE_REVEAL_3_MS / 1000}`);
  });

  it('4 colors and 7 colors: both reach safe level with the same "no outline" text (boundary)', () => {
    expect(colorNudge(4)).toEqual({ level: 'safe', text: '완벽 위장 — 테두리 없음' });
    expect(colorNudge(7)).toEqual({ level: 'safe', text: '완벽 위장 — 테두리 없음' });
  });

  it('a negative count is not a real distinctColorCount output — treated like <=1, danger (error/extreme)', () => {
    expect(colorNudge(-1).level).toBe('danger');
  });

  it('a non-integer count is not a real distinctColorCount output — treated like <=1, danger (error/extreme)', () => {
    expect(colorNudge(2.5).level).toBe('danger');
  });
});
