/**
 * scripts/pre-clean-dist.mjs —— electron-builder 打包前清理上次产物。
 *
 * Windows 上 freshly-written 的 app.asar 常被杀毒/索引服务短暂锁定，导致下次
 * `electron-builder` unlink 失败（EBUSY）。这里带重试地删除输出目录里的
 * win-unpacked（安装器 exe 保留可复用），失败也不阻塞打包（builder 会自建目录）。
 *
 * 用法：node scripts/pre-clean-dist.mjs <outputDir...>   （默认 release/release2/release3）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** electron-builder 输出目录（electron-builder.yml 指向 LOCALAPPDATA 下的独立目录，避开同步/扫描锁定） */
const builderOutput = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'pindou-studio-release',
);

const dirs = process.argv.slice(2);
const targets = (dirs.length > 0
  ? dirs
  // 默认清理全部 release* 输出目录里的 win-unpacked（安装器 exe 与 blockmap 保留可复用）
  : fs.readdirSync(process.cwd())
      .filter((d) => /^release\d*$/.test(d) && fs.statSync(path.join(process.cwd(), d)).isDirectory())
        .concat([builderOutput]))
  .map((d) => path.join(path.resolve(d), 'win-unpacked'));

for (const dir of targets) {
  if (!fs.existsSync(dir)) continue;
  let removed = false;
  for (let attempt = 1; attempt <= 10 && !removed; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
      console.log(`[pre-clean] 已清理 ${dir}`);
    } catch (err) {
      if (attempt === 10) {
        console.warn(`[pre-clean] ${dir} 仍被占用（${err.code ?? err.message}），交给 builder 自行处理`);
      } else {
        await sleep(4000);
      }
    }
  }
}
