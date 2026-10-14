// eslint.config.js —— lint 门禁。
// 定位：错误级拦截（no-unused-vars / rules-of-hooks 等），exhaustive-deps 暂为警告级
// ——存量警告属行为敏感改动，先挂账、逐个消化，不宜自动修复。
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // 产物目录、C# 旁路与 Node 脚本不入 lint 范围
  { ignores: ['dist/**', 'release*/**', 'tools/**', 'scripts/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 主进程/preload 与共享模块是纯 Node 环境
    files: ['electron/**/*.mjs', 'shared/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
