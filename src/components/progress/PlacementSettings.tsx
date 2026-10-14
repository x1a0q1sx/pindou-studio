/**
 * progress/PlacementSettings.tsx —— 拼豆模式联动开关 + 发光增强滑杆。
 *
 * 联动开关：进入拼豆模式时自动全屏 / 自动切 focus 布局 / 自动切 glowDark 主题 / 防休眠 / 面板压暗。
 *   —— 把 useHotkeys 里原先写死的 PLACEMENT_AUTO_FULLSCREEN / PLACEMENT_LAYOUT / PLACEMENT_THEME 改为可配置。
 * 发光增强：亮度 / 饱和度 / 外发光强度 / 空格纯黑，补偿透明拼豆板色偏。
 *   —— 滑杆 onChange 时 bump beadsVersion 触发渲染器重绘。
 */
import { useCallback, useRef } from 'react';
import { usePdbStore } from '@/store';
import { usePlacementPrefs } from '@/store/placementPrefs';
import { Switch } from '@/components/ui/Switch';
import { Slider } from '@/components/ui/Slider';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import './progress.css';

export function PlacementSettings() {
  const autoFullscreen = usePlacementPrefs((s) => s.autoFullscreen);
  const autoLayout = usePlacementPrefs((s) => s.autoLayout);
  const autoTheme = usePlacementPrefs((s) => s.autoTheme);
  const keepAwake = usePlacementPrefs((s) => s.keepAwake);
  const dimPanels = usePlacementPrefs((s) => s.dimPanels);
  const brightness = usePlacementPrefs((s) => s.brightness);
  const saturation = usePlacementPrefs((s) => s.saturation);
  const glowBoost = usePlacementPrefs((s) => s.glowBoost);
  const pureBlackEmpty = usePlacementPrefs((s) => s.pureBlackEmpty);
  const update = usePlacementPrefs((s) => s.update);
  const resetGlow = usePlacementPrefs((s) => s.resetGlow);
  const resetLinkage = usePlacementPrefs((s) => s.resetLinkage);

  /* glow 滑杆变更后 debounce bump beadsVersion 触发重绘 */
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRedraw = useCallback(() => {
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => {
      usePdbStore.getState().mutateBeads(() => { /* no-op: 仅 bump version */ });
    }, 80);
  }, []);

  const fmt = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <section className="pdb-psettings" aria-label="拼豆模式设置">
      {/* ═══ 联动开关 ═══ */}
      <header className="pdb-psettings__head">
        <span className="pdb-label">
          <PdbIcon name="settings" size={13} />
          进入拼豆模式联动
        </span>
        <Button size="sm" variant="ghost" onClick={resetLinkage} title="恢复联动默认值">
          重置
        </Button>
      </header>

      <div className="pdb-psettings__switches">
        <Switch checked={autoFullscreen} onChange={(v) => update({ autoFullscreen: v })} label="自动全屏" />
        <Switch checked={autoLayout} onChange={(v) => update({ autoLayout: v })} label="自动切专注布局" />
        <Switch checked={autoTheme} onChange={(v) => update({ autoTheme: v })} label="自动切发光主题" />
        <Switch checked={keepAwake} onChange={(v) => update({ keepAwake: v })} label="防休眠" />
        <Switch checked={dimPanels} onChange={(v) => update({ dimPanels: v })} label="极简拼豆（隐藏全部面板，只留板子 + 浮动按钮）" />
      </div>

      {/* ═══ 发光增强 ═══ */}
      <header className="pdb-psettings__head">
        <span className="pdb-label">
          <PdbIcon name="bead" size={13} />
          发光底板增强
        </span>
        <Button size="sm" variant="ghost" onClick={resetGlow} title="恢复发光默认值">
          重置
        </Button>
      </header>

      <div className="pdb-psettings__sliders">
        <div className="pdb-psettings__row">
          <span className="pdb-psettings__name">亮度</span>
          <Slider
            min={0.6} max={1.8} step={0.05}
            value={brightness}
            onValueChange={(v) => { update({ brightness: v }); scheduleRedraw(); }}
            format={fmt}
            aria-label="亮度增强"
          />
        </div>
        <div className="pdb-psettings__row">
          <span className="pdb-psettings__name">饱和度</span>
          <Slider
            min={0.6} max={2.2} step={0.05}
            value={saturation}
            onValueChange={(v) => { update({ saturation: v }); scheduleRedraw(); }}
            format={fmt}
            aria-label="饱和度增强"
          />
        </div>
        <div className="pdb-psettings__row">
          <span className="pdb-psettings__name">外发光</span>
          <Slider
            min={0} max={2.5} step={0.1}
            value={glowBoost}
            onValueChange={(v) => { update({ glowBoost: v }); scheduleRedraw(); }}
            format={(v) => v.toFixed(1)}
            aria-label="外发光强度"
          />
        </div>
      </div>

      <div className="pdb-psettings__switches">
        <Switch checked={pureBlackEmpty} onChange={(v) => { update({ pureBlackEmpty: v }); scheduleRedraw(); }} label="空格纯黑" />
      </div>

      <p className="pdb-hint">
        提示：空格纯黑与发光增强仅在 glowDark 主题下可见效果。
      </p>
    </section>
  );
}
