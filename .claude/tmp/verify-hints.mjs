import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://localhost:3000');
await page.fill('input[aria-label="닉네임"]', '호스트');
await page.fill('input[aria-label="방 이름"]', '재현방');
await page.click('button.mc-btn:has-text("만들기")');
await page.waitForSelector('.mc-room-screen');
// 두 명 더 입장
const p2 = await browser.newPage(); await p2.goto('http://localhost:3000');
await p2.fill('input[aria-label="닉네임"]', '멤버1'); await p2.click('button.mc-room-card');
const p3 = await browser.newPage(); await p3.goto('http://localhost:3000');
await p3.fill('input[aria-label="닉네임"]', '멤버2'); await p3.click('button.mc-room-card');
await page.waitForTimeout(600);
const hints = await page.evaluate(() => [...document.querySelectorAll('.mc-start-hints li')].map(l => l.textContent));
const disabled = await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === '시작')?.disabled);
console.log('host-hints:', JSON.stringify(hints), '| start-disabled:', disabled);
const guestHints = await p2.evaluate(() => [...document.querySelectorAll('.mc-start-hints li')].map(l => l.textContent));
console.log('guest-hints:', JSON.stringify(guestHints));
await page.screenshot({ path: '.claude/tmp/start-hints.png' });
// 배경 설정 후 활성화 확인
await page.fill('input[aria-label="배경 URL"]', 'https://example.com');
await page.click('button:has-text("가져오기")');
await page.waitForSelector('img[alt="배경 미리보기"]', { timeout: 30000 });
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  disabled: [...document.querySelectorAll('button')].find(b => b.textContent === '시작')?.disabled,
  hints: document.querySelector('.mc-start-hints') !== null,
}));
console.log('after-bg:', JSON.stringify(after));
await page.screenshot({ path: '.claude/tmp/start-enabled.png' });
await browser.close();
