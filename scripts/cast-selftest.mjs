/**
 * scripts/cast-selftest.mjs —— 投图服务端到端自测（纯 Node，无需 Electron）。
 * startCast → GET 上传页 → POST /api/upload（带 token）→ 断言推送回调收到载荷。
 */
import { startCast, stopCast, castState } from '../electron/cast.mjs';

const pushed = [];
const st = await startCast((p) => pushed.push(p));
if (!st.ok || !st.running) {
  console.log('FAIL start', st.error);
  process.exit(1);
}
const pageUrl = `http://127.0.0.1:${st.port}/`;
const apiUrl = `http://127.0.0.1:${st.port}/api/upload?t=${st.token}`;

// 1. 上传页可打开且含手机选择 UI
const page = await (await fetch(pageUrl)).text();
console.log('page-ok:', page.includes('投图到拼豆工作台') && page.includes('type="file"'));

// 2. 无 token → 403
const deny = await fetch(`http://127.0.0.1:${st.port}/api/upload?t=wrong`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'x.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', pane: 'B' }),
});
console.log('deny-403:', deny.status === 403);

// 3. 合法上传 → 推送回调收到，pane/name 透传
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const up = await (await fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '手机图.png', mime: 'image/png', dataUrl: tinyPng, pane: 'B' }),
})).json();
console.log('upload-ok:', up.ok === true);
console.log('pushed:', pushed.length === 1 && pushed[0].pane === 'B' && pushed[0].name === '手机图.png' && pushed[0].dataUrl === tinyPng);

// 4. 非图片 dataUrl 被拒
const bad = await (await fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'x.png', dataUrl: 'data:text/html;base64,PGJvZHk+', pane: 'A' }),
})).json();
console.log('bad-image-400:', bad.ok === false && bad.error === 'bad image');

// 5. state 查询 + 停止
console.log('state-running:', castState().running === true && castState().urls.length > 0);
stopCast();
console.log('stopped:', castState().running === false);
const gone = await fetch(pageUrl).then(() => 'still-up').catch(() => 'closed');
console.log('server-closed:', gone === 'closed');
// 不 process.exit：让服务 socket 自然排空退出，避免 Windows libuv 拆除断言
