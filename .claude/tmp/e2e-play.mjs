import { chromium } from 'playwright';
import fs from 'node:fs';
const VIDEO_DIR = '/Users/choeyeong-gi/workspace/mechameleon-web/e2e-videos';
fs.mkdirSync(VIDEO_DIR, { recursive: true });
const browser = await chromium.launch();
const mkCtx = () => browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } });

const ctxA = await mkCtx(); const ctxB = await mkCtx();
const A = await ctxA.newPage(); const B = await ctxB.newPage();

// 1) 방 만들기 (A)
await A.goto('http://localhost:3000');
await A.fill('input[aria-label="닉네임"]', '영기');
await A.fill('input[aria-label="방 이름"]', '몰컴 시연');
await A.waitForTimeout(800);
await A.click('button.mc-btn:has-text("만들기")');
await A.waitForSelector('.mc-room-screen');

// 2) 참여 (B) — 방 목록 카드 클릭
await B.goto('http://localhost:3000');
await B.fill('input[aria-label="닉네임"]', '깜몬');
await B.waitForSelector('button.mc-room-card', { timeout: 10000 });
await B.waitForTimeout(600);
await B.click('button.mc-room-card');
await B.waitForSelector('.mc-room-screen');

// 3) 배경 캡처 — 게임 로비 자체를 배경으로 (로컬·결정적)
await A.fill('input[aria-label="배경 URL"]', 'http://localhost:3000');
await A.click('button:has-text("가져오기")');
await A.waitForSelector('img[alt="배경 미리보기"]', { timeout: 45000 });
await A.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '시작')?.disabled);
await A.waitForTimeout(800);

// 4) 시작
await A.click('button:has-text("시작")');

// 5) 역할 판별
const findHider = async () => {
  for (let i = 0; i < 50; i++) {
    for (const [name, page] of [['A', A], ['B', B]]) {
      const hasConfirm = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent === '확정'));
      if (hasConfirm) return name;
    }
    await A.waitForTimeout(200);
  }
  throw new Error('no hider UI appeared');
};
const hiderName = await findHider();
const hider = hiderName === 'A' ? A : B;
const seeker = hiderName === 'A' ? B : A;
console.log('hider:', hiderName === 'A' ? '영기(A)' : '깜몬(B)');

// 6) 숨기: 이동 + 부위별 스포이드 색칠
let ex = 720, ey = 450; // 기본 위치 = 배경 중앙 (1440x900)
const shiftMove = async (key, dx, dy, times) => {
  for (let i = 0; i < times; i++) {
    await hider.keyboard.press(`Shift+${key}`);
    ex = Math.min(Math.max(ex + dx, 0), 1440);
    ey = Math.min(Math.max(ey + dy, 0), 900);
    await hider.waitForTimeout(120);
  }
};
await hider.waitForTimeout(600);
await shiftMove('ArrowRight', 16, 0, 3);
await shiftMove('ArrowDown', 0, 16, 1);
// 부위 1~6 선택 후 주변 배경색 클릭(스포이드)
const bgCanvas = hider.locator('canvas').first();
const paintSpots = [[80, -60], [90, -30], [-60, -40], [110, -40], [-70, 30], [100, 30]];
for (let part = 1; part <= 6; part++) {
  await hider.keyboard.press(String(part));
  const [ox, oy] = paintSpots[part - 1];
  await bgCanvas.click({ position: { x: ex + ox, y: ey + oy } });
  await hider.waitForTimeout(250);
}
await hider.waitForTimeout(500);
await hider.click('button:has-text("확정")');
console.log('hidden at:', ex, ey);

// 7) 찾기: 오클릭(파문+3초 잠금) → 정답 클릭
await seeker.waitForSelector('canvas', { timeout: 10000 });
await seeker.waitForTimeout(1000);
const overlay = seeker.locator('canvas').nth(1);
await overlay.click({ position: { x: 250, y: 200 } }); // 일부러 빗나감
console.log('missed on purpose — 3s lockout');
await seeker.waitForTimeout(3500);
await overlay.click({ position: { x: ex, y: ey - 70 } }); // 몸통 정중앙
await seeker.waitForTimeout(1000);

// 8) 결과 화면 감상
const resultA = await A.evaluate(() => document.body.innerText.slice(0, 60).replace(/\n/g, ' | '));
const resultB = await B.evaluate(() => document.body.innerText.slice(0, 60).replace(/\n/g, ' | '));
console.log('A-result:', JSON.stringify(resultA));
console.log('B-result:', JSON.stringify(resultB));
await A.waitForTimeout(4000);

const vA = A.video(); const vB = B.video();
await ctxA.close(); await ctxB.close();
const pA = await vA.path(); const pB = await vB.path();
fs.renameSync(pA, `${VIDEO_DIR}/${hiderName === 'A' ? 'hider-영기' : 'seeker-영기'}.webm`);
fs.renameSync(pB, `${VIDEO_DIR}/${hiderName === 'A' ? 'seeker-깜몬' : 'hider-깜몬'}.webm`);
await browser.close();
console.log('videos saved:', fs.readdirSync(VIDEO_DIR).join(', '));
