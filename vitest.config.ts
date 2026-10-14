import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * tests/vitest 配置：与 vite.config.ts 同源别名；node 环境直跑纯算法用例。
 * 只收 tests/**，src 内不放置测试文件（保持 src 即产物的约定）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 说明：Vitest 默认按「文件」隔离（每文件独立 worker、文件内串行执行），
    // 历史栈等模块级单例不会跨用例文件互相污染，无需额外 pool 配置。
  },
});
