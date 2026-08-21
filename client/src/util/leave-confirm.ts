// Two-step leave confirm (D4): shared by the mid-game screens (hide edit,
// hide wait, seek) so a single accidental tap can't drop a player out of a
// live game. First click arms a 3s confirm window; a second click within it
// leaves; letting the window lapse reverts to idle with no side effect.
const CONFIRM_TIMEOUT_MS = 3000;
const IDLE_LABEL = '나가기';
const CONFIRM_LABEL = '한 번 더 누르면 나가요';
const IDLE_CLASS = 'mc-btn mc-btn--ghost';
const CONFIRM_CLASS = 'mc-btn mc-btn--red';

export function attachLeaveConfirm(btn: HTMLButtonElement, onConfirmed: () => void): () => void {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  function toIdle(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    btn.textContent = IDLE_LABEL;
    btn.className = IDLE_CLASS;
  }

  function onClick(): void {
    if (timerId !== null) {
      toIdle();
      onConfirmed();
      return;
    }
    btn.textContent = CONFIRM_LABEL;
    btn.className = CONFIRM_CLASS;
    timerId = setTimeout(toIdle, CONFIRM_TIMEOUT_MS);
  }

  toIdle();
  btn.addEventListener('click', onClick);

  return () => {
    btn.removeEventListener('click', onClick);
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
}
