/**
 * scripts/clean.mjs —— 项目瘦身清理（npm run clean）。
 *
 * 项目体积大头从来不是源码（< 5MB），而是打包产物：
 *   ・各 release 目录下的 win-unpacked：electron 运行时解包目录（每个约 250MB）
 *   ・各 release 目录下的安装器 exe（每个约 112MB）
 *   ・node_modules/.cache、node_modules/.tmp
 * 本脚本清理以上全部；node_modules 下的 electron（372MB）为开发必需，保留。
 *
 * 被杀软/同步驱动锁住的文件删除失败时，登记「重启后删除」（MoveFileEx DELAY_UNTIL_REBOOT）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 待删除目录 */
const targets = fs
  .readdirSync(root)
  .filter((d) => /^release\d*$/.test(d) && fs.statSync(path.join(root, d)).isDirectory())
  .map((d) => path.join(root, d));

// 缓存目录
for (const c of ['node_modules/.cache', 'node_modules/.tmp']) {
  const p = path.join(root, c);
  if (fs.existsSync(p)) targets.push(p);
}

/** 删除失败文件的「重启后删除」登记（MoveFileEx + MOVEFILE_DELAY_UNTIL_REBOOT） */
async function scheduleRebootDelete(file) {
  const { spawnSync } = await import('node:child_process');
  const ps = [
    `$src = '${file.replace(/'/g, "''")}'`,
    '$bin = Add-Type -MemberDefinition \'[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool MoveFileEx(string a, string b, int f);\' -Name K -Namespace W -PassThru',
    '[void]($bin::MoveFileEx($src, $null, 4))',
  ].join('; ');
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
}

let freedHint = 0;
const locked = [];
for (const dir of targets) {
  if (!fs.existsSync(dir)) continue;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      freedHint += dirSize(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[clean] 已删除 ${path.relative(root, dir)}`);
      break;
    } catch (err) {
      if (attempt === 3) {
        locked.push(dir);
        console.warn(`[clean] ${path.relative(root, dir)} 有文件被占用（${err.code ?? err.message}），已登记重启后自动删除`);
        // 逐文件登记仍存在的文件
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else scheduleRebootDelete(full);
          }
          scheduleRebootDelete(d);
        };
        try { walk(dir); } catch { /* 目录可能已被部分删除 */ }
      } else {
        await sleep(1200);
      }
    }
  }
}

function dirSize(d) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      n += e.isDirectory() ? dirSize(full) : e.size;
    }
  } catch { /* 忽略 */ }
  return n;
}

if (locked.length > 0) {
  console.log('[clean] 被锁文件将在下次重启时自动消失（占用方多为杀软/云同步实时引擎；也可暂时暂停它们后重跑 npm run clean）');
}
const mb = dirSize(root) / 1024 / 1024;
console.log('[clean] 清理完成。当前项目体积：', Number.isFinite(mb) ? mb.toFixed(0) + ' MB' : '(含系统锁定目录，略)');
