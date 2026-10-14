/**
 * App.tsx —— 应用装配：AppShell（4 布局）+ Toast 容器 + 启动自检。
 *
 * useDisplayInfo hook 接管显示器检测与校准初始化。
 */
import { useEffect } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ToastContainer } from '@/components/ui/Toast';
import { loadAppearance } from '@/components/theme/appearance';
import { applyThemeById, getTheme, readThemeCssVar } from '@/themes';
import { getBridge } from '@/io/bridge';
import { usePdbStore } from '@/store';
import { useDisplayInfo } from '@/hooks/useDisplayInfo';

export default function App() {
  // : 显示器检测与校准初始化（包含启动拉取 + 变化订阅 + 浏览器降级提示）
  useDisplayInfo();

  useEffect(() => {
    const store = usePdbStore.getState();

    // 1. 恢复持久化外观
    const appearance = loadAppearance();
    if (appearance.theme && appearance.theme !== store.theme) {
      store.setTheme(appearance.theme);
    }
    if (appearance.layout && appearance.layout !== store.layout) {
      store.setLayout(appearance.layout);
    }
    applyThemeById(usePdbStore.getState().theme);

    // 2. 环境探测与令牌验证（简化版，显示器检测已由 useDisplayInfo 接管）
    void (async () => {
      const bridge = getBridge();
      try {
        const info = await bridge.getAppInfo();
        const theme = getTheme(usePdbStore.getState().theme);
        const cssVarProof = readThemeCssVar('--primary');
        console.info(
          '[PinDou] 启动自检',
          `\n  环境: ${bridge.env} (v${info.version}, ${info.platform})`,
          `\n  主题: ${theme.id}`,
          `\n  UI 令牌验证（:root 计算样式 --primary）: ${cssVarProof}`,
          `\n  Canvas 令牌验证: canvasBg=${theme.canvas.canvasBg}, gridLine=${theme.canvas.gridLine}`,
        );
      } catch (err) {
        console.warn('[PinDou] 启动自检失败（不影响使用）', err);
      }
    })();
  }, []);

  return (
    <>
      <AppShell />
      <ToastContainer />
    </>
  );
}
