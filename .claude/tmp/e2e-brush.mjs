import { chromium } from 'playwright';
import fs from 'node:fs';
const VIDEO_DIR = '/Users/choeyeong-gi/workspace/mechameleon-web/e2e-videos';
const browser = await chromium.launch();
const mkCtx = () => browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } });
const ctxA = await mkCtx(); const ctxB = await mkCtx();
const A = await ctxA.newPage(); const B = await ctxB.newPage();

await A.goto('http://localhost:3000');
await A.fill('input[aria-label="닉네임"]', '영기');
await A.fill('input[aria-label="방 이름"]', '붓칠 시연');
await A.click('button.mc-btn:has-text("만들기")');
await A.waitForSelector('.mc-room-screen');
await B.goto('http://localhost:3000');
await B.fill('input[aria-label="닉네임"]', '깜몬');
await B.waitForSelector('button.mc-room-card');
await B.waitForTimeout(400);
await B.click('button.mc-room-card');
await B.waitForSelector('.mc-room-screen');
await A.fill('input[aria-label="배경 URL"]', 'http://localhost:3000');
await A.click('button:has-text("가져오기")');
await A.waitForSelector('img[alt="배경 미리보기"]', { timeout: 45000 });
await A.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '시작')?.disabled);
await A.click('button:has-text("시작")');

let hider = null, seeker = null, hiderName = '';
for (let i = 0; i < 50 && !hider; i++) {
  for (const [name, page] of [['영기', A], ['깜몬', B]]) {
    if (await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent === '확정'))) {
      hider = page; seeker = name === '영기' ? B : A; hiderName = name;
    }
  }
  if (!hider) await A.waitForTimeout(200);
}
console.log('hider:', hiderName);

const ex = 720, ey = 450; // 기본 위치 유지 (이동 없이 색칠 시연)
const bg = hider.locator('canvas').first();
const box = await bg.boundingBox();
const at = (ix, iy) => ({ x: box.x + ix, y: box.y + iy });

// 1) Alt+클릭 스포이드: 배경 회색 상단바 부분 색 따오기
await bg.click({ position: { x: 200, y: 10 }, modifiers: ['Alt'] });
const swatch1 = await hider.evaluate(() => document.querySelector('.mc-swatch')?.style.background);
console.log('eyedrop-1:', swatch1);
// 2) 몸통 위를 지그재그로 드래그 색칠
const drag = async (points) => {
  const [f, ...rest] = points;
  await hider.mouse.move(...Object.values(at(f[0], f[1])));
  await hider.mouse.down();
  for (const [x, y] of rest) { await hider.mouse.move(...Object.values(at(x, y)), { steps: 4 }); }
  await hider.mouse.up();
  await hider.waitForTimeout(200);
};
await drag([[700, 350], [740, 360], [700, 380], [740, 395], [700, 410]]);
// 3) 다른 색 스포이드(로비 스크린샷의 초록 버튼 근처) 후 다리 쪽 칠하기
await bg.click({ position: { x: 975, y: 504 }, modifiers: ['Alt'] });
const swatch2 = await hider.evaluate(() => document.querySelector('.mc-swatch')?.style.background);
console.log('eyedrop-2:', swatch2);
await drag([[705, 420], [735, 435], [710, 450]]);
await hider.waitForTimeout(400);
const strokesSent = await hider.evaluate(() => true);
await hider.click('button:has-text("확정")');
console.log('confirmed, strokes drawn');

// 4) 찾기: 오클릭 → 잠금 → 정답
await seeker.waitForSelector('canvas', { timeout: 10000 });
await seeker.waitForTimeout(800);
const overlay = seeker.locator('canvas').nth(1);
await overlay.click({ position: { x: 300, y: 250 } });
await seeker.waitForTimeout(3500);
await overlay.click({ position: { x: ex, y: ey - 70 } });
await seeker.waitForTimeout(1000);
console.log('result:', JSON.stringify(await seeker.evaluate(() => document.body.innerText.slice(0, 50).replace(/\n/g, ' | '))));
await A.waitForTimeout(3000);
const vA = A.video(); const vB = B.video();
await ctxA.close(); await ctxB.close();
fs.renameSync(await vA.path(), `${VIDEO_DIR}/brush-${hiderName === '영기' ? 'hider' : 'seeker'}-영기.webm`);
fs.renameSync(await vB.path(), `${VIDEO_DIR}/brush-${hiderName === '영기' ? 'seeker' : 'hider'}-깜몬.webm`);
await browser.close();
console.log('videos:', fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith('brush')).join(', '));
