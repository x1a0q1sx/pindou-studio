import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * 生产构建注入 CSP meta（杂项加固）：
 * dev 不注入——Vite 的 HMR 内联脚本/WS 会被 CSP 掐断；Electron 生产走 file:// 全本地资源，白名单收敛。
 * 注意 style-src 需要 unsafe-inline（React 内联样式属性）；img 需要 blob:/data:（预览 ObjectURL / 项目内嵌源图）。
 * img-src 额外放行 reddit / pixilart CDN —— 图纸 Web 搜索结果的缩略图 <img> 直链这些域；
 *   JSON 与「导入原图」的下载走主进程 net.fetch，不经渲染进程，connect-src 无需放宽。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://s3.amazonaws.com https://kandipatterns.com https://static.pindouclub.cn https://www.kandipatterns.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const cspMetaPlugin = () => ({
  name: 'pdb-csp-meta',
  apply: 'build' as const,
  transformIndexHtml(html: string): string {
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
});

// base:'./' —— Electron 生产模式以 file:// 加载 dist/index.html，必须用相对路径
export default defineConfig({
  base: './',
  plugins: [react(), cspMetaPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    // （图片像素化 Web Worker）依赖此配置：worker 以 ES Module 打包
    format: 'es',
  },
  server: {
    // 固定绑 IPv4 回环：本机 localhost 优先解析为 IPv6 ::1，而 dev 脚本的
    // `wait-on tcp:127.0.0.1:5173` 走 IPv4——不显式指定 host 会导致 wait-on 永远连不上、electron 不启动。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
