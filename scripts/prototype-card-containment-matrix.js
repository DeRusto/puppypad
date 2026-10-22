// PROTOTYPE, throwaway: runs every guard level x attack in headless Chromium and prints the hit-test failures (DeRusto/puppypad#124).
const { chromium } = require('/home/user/puppypad/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 900 } });
  const f = 'file:///home/user/puppypad/prototype-card-containment.html';
  for (const attack of ['', 'overlay', 'overlay,bump', 'link', 'move', 'wide', 'fixed'])
    for (const g of [0, 1, 2, 3, 4]) {
      await p.goto(`${f}?guard=${g}&attack=${attack}`); await p.waitForFunction(() => window.RESULT);
      const fails = (await p.evaluate(() => window.RESULT)).filter((l) => l.startsWith('FAIL'));
      console.log(`${(attack||'benign only').padEnd(13)} g${g}: ${fails.length ? fails.map((l) => l.slice(5)).join(' ; ') : 'all OK'}`);
      if (g >= 2) await p.screenshot({ path: `/home/user/puppypad/proto-shots/${(attack||'benign').replace(',', '+')}-g${g}.png` });
    }
  await b.close();
})();
