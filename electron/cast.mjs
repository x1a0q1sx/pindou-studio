/**
 * electron/cast.mjs —— 手机投图：局域网 HTTP 服务。
 *
 * 手机与电脑连同一路由器 → 扫 CastDialog 里的二维码打开本页 → 选图 → POST 回电脑。
 * 服务端不碰文件系统：校验 token + 体积 + dataUrl 白名单后原样推给渲染进程
 * （渲染进程转 File 走既有导入/像素化管线）。
 *
 * 安全：监听 0.0.0.0 仅限局域网场景，所有接口要求 ?t=<token>；token 随服务启动
 * 随机生成，经二维码分发；单请求体 ≤9MB；跨域头只放同端口自带页（同源，实际不需要）。
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const BASE_PORT = 4763;
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** @type {{running:boolean, port:number, token:string, urls:string[]}} */
const state = { running: false, port: 0, token: '', urls: [] };
/** @type {import('node:http').Server | null} */
let server = null;

function lanIPv4s() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function refreshUrls() {
  state.urls = lanIPv4s().map((ip) => `http://${ip}:${state.port}/?t=${state.token}`);
}

/* 手机端上传页：token 从页面 URL 带入，提交时拼回接口。无外部资源，离线可用。 */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>投图到拼豆工作台</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;background:#101319;color:#eee;margin:0;padding:20px}
 .card{max-width:460px;margin:0 auto}
 h1{font-size:20px} .sub{color:#9aa;font-size:13px;margin-bottom:18px}
 label.blk{display:block;margin:14px 0 6px;color:#bcd;font-size:14px}
 input[type=file]{width:100%;padding:10px;border:1.5px dashed #445;border-radius:10px;color:#ccc}
 .panes{display:flex;gap:10px;margin:6px 0 0}
 .panes label{flex:1;border:1.5px solid #334;border-radius:10px;padding:10px;font-size:14px;cursor:pointer}
 .panes label.on{border-color:#7fb6ff;background:#16233a}
 .panes small{display:block;color:#89a;font-size:12px;margin-top:2px}
 button{width:100%;margin-top:18px;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#2f7bff;border:0;border-radius:12px}
 button:disabled{background:#345;color:#89a}
 #msg{margin-top:12px;font-size:14px;color:#8d5;min-height:20px}
</style></head><body><div class="card">
 <h1>📱 投图到拼豆工作台</h1>
 <div class="sub">选一张图，投到电脑上的画板。</div>
 <label class="blk">图片</label>
 <input id="f" type="file" accept="image/*">
 <label class="blk">投到哪里</label>
 <div class="panes">
   <label id="pA" class="on"><input type="radio" name="pane" value="A" hidden>图 A · 主画板<small>打开导入向导（可裁剪/配色）</small></label>
   <label id="pB"><input type="radio" name="pane" value="B" hidden>图 B · 对照屏<small>按图 B 板尺寸自动像素化</small></label>
 </div>
 <button id="go" disabled>发送</button>
 <div id="msg"></div>
</div>
<script>
 var t = new URLSearchParams(location.search).get('t') || '';
 var file = null, pane = 'A';
 var f = document.getElementById('f'), go = document.getElementById('go'), msg = document.getElementById('msg');
 f.onchange = function(){ file = f.files[0]; go.disabled = !file; msg.textContent = file ? ('已选择：' + file.name) : ''; };
 document.querySelectorAll('input[name=pane]').forEach(function(r){
   r.onchange = function(){ pane = r.value;
     document.getElementById('pA').className = pane==='A' ? 'on' : '';
     document.getElementById('pB').className = pane==='B' ? 'on' : ''; };
 });
 go.onclick = function(){
   if (!file) return;
   go.disabled = true; msg.textContent = '上传中…';
   var fr = new FileReader();
   fr.onload = function(){
     var name = file.name.length > 100 ? file.name.slice(-100) : file.name;
     fetch('/api/upload?t=' + encodeURIComponent(t), {
       method: 'POST', headers: {'Content-Type':'application/json'},
       body: JSON.stringify({ name: name, mime: file.type || 'image/png', dataUrl: String(fr.result), pane: pane })
     }).then(function(r){ return r.json(); }).then(function(j){
       msg.textContent = j && j.ok ? '✅ 已投到电脑（图 ' + pane + '）' : '❌ 失败：' + (j && j.error || 'HTTP');
     }).catch(function(e){ msg.textContent = '❌ 网络错误：' + e; })
     .finally(function(){ go.disabled = false; });
   };
   fr.onerror = function(){ msg.textContent = '❌ 读取文件失败'; go.disabled = false; };
   fr.readAsDataURL(file);
 };
</script></body></html>`;

function respond(res, code, obj, onFinished) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  // onFinished 挂在 flush 回调：立即 destroy 会丢弃未 flush 的写缓冲，
  // 客户端表现为连接悬挂而非收到状态码
  res.end(body, onFinished);
}

/**
 * @param {(payload:{pane:string,name:string,mime:string,dataUrl:string}) => void} onPush 收到上传时的回调（推给渲染进程）
 * @returns {{ok:boolean, error?:string} & typeof state}
 */
export function startCast(onPush) {
  if (state.running) return { ok: true, ...state };
  let tried = 0;
  const listen = (port) => new Promise((resolve, reject) => {
    const sv = createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE.replace(/__NOTHING__/g, ''));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/upload') {
        if (u.searchParams.get('t') !== state.token) { respond(res, 403, { ok: false, error: 'bad token' }); return; }
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            // 回 413 并等 flush 完再断连接：立即 destroy 会丢弃未 flush 的写缓冲，
            // 客户端收不到 413 只会看到连接悬挂
            respond(res, 413, { ok: false, error: 'too large' }, () => req.destroy());
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const dataUrl = typeof j.dataUrl === 'string' ? j.dataUrl : '';
            if (!DATA_URL_RE.test(dataUrl)) { respond(res, 400, { ok: false, error: 'bad image' }); return; }
            const mime = (dataUrl.match(/^data:image\/([a-z]+);/i)?.[1] ?? 'png').toLowerCase();
            const payload = {
              pane: j.pane === 'B' ? 'B' : 'A',
              name: String(j.name ?? '').slice(0, 120) || `手机图片.${mime === 'jpeg' ? 'jpg' : mime}`,
              mime: `image/${mime === 'jpg' ? 'jpeg' : mime}`,
              dataUrl,
            };
            onPush(payload);
            respond(res, 200, { ok: true });
          } catch {
            respond(res, 400, { ok: false, error: 'bad json' });
          }
        });
        return;
      }
      respond(res, 404, { ok: false, error: 'not found' });
    });
    sv.once('error', reject);
    sv.listen(port, '0.0.0.0', () => resolve(sv));
  });

  return (async () => {
    let sv = null;
    let bound = 0;
    // token 先于 listen 生成：处理首个请求时 state.token 已就绪
    state.token = randomBytes(8).toString('hex');
    while (tried < 6 && !sv) {
      try {
        sv = await listen(BASE_PORT + tried);
        bound = BASE_PORT + tried;
      } catch {
        tried += 1;
      }
    }
    if (!sv) { state.token = ''; return { ok: false, error: 'port-busy', ...state }; }
    server = sv;
    state.running = true;
    state.port = bound;
    refreshUrls();
    return { ok: true, ...state };
  })();
}

export function stopCast() {
  if (server) {
    server.closeAllConnections?.();
    server.close();
    server = null;
  }
  state.running = false;
  state.port = 0;
  state.token = '';
  state.urls = [];
  return { ok: true, ...state };
}

export function castState() {
  if (state.running) refreshUrls(); // 拔插网线后 IP 可能变化
  return { ok: true, ...state };
}
