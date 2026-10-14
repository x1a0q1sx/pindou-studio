/**
 * scripts/dist-win.mjs —— electron-builder 的重试包装。
 * Windows 上新写入的 electron 运行时文件会被杀软实时扫描短暂锁定，导致
 * 「EBUSY unlink / EPERM rename win-unpacked.tmp」偶发失败；这里失败后等待重试。
 */
import { spawnSync } from 'node:child_process';

const ATTEMPTS = 5;
for (let i = 1; i <= ATTEMPTS; i++) {
  const r = spawnSync('npx', ['electron-builder', '--win'], { stdio: 'inherit', shell: true });
  if (r.status === 0) {
    process.exit(0);
  }
  if (i < ATTEMPTS) {
    console.log(`\n[dist] 第 ${i}/${ATTEMPTS} 次打包失败（常见原因：杀软扫描锁定新文件），20 秒后重试…\n`);
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
}
console.error('[dist] 连续失败：请关闭可能占用 release 目录的资源管理器窗口或暂停杀软扫描后重试');
process.exit(1);
