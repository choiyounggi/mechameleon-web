import { chromium } from 'playwright';
const browser = await chromium.launch();
const empty = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await empty.goto('http://localhost:3000');
await empty.waitForSelector('.mc-panels');
const rects = await empty.evaluate(() => [...document.querySelectorAll('.mc-panel')].map(p => { const r = p.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }));
console.log('empty-panels:', JSON.stringify(rects));
await empty.screenshot({ path: '../.claude/tmp/align-empty.png' });
// 방 두 개 만든 상태의 목록
const maker = await browser.newPage();
await maker.goto('http://localhost:3000');
await maker.fill('input[aria-label="닉네임"]', '개설자');
await maker.fill('input[aria-label="방 이름"]', '점심 몰컴');
await maker.click('button.mc-btn:has-text("만들기")');
await maker.waitForSelector('.mc-room-screen');
await empty.waitForTimeout(3500); // 폴링 주기 대기
const rects2 = await empty.evaluate(() => [...document.querySelectorAll('.mc-panel')].map(p => { const r = p.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }));
console.log('withroom-panels:', JSON.stringify(rects2));
await empty.screenshot({ path: '../.claude/tmp/align-rooms.png' });
await browser.close();
