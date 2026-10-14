/**
 * layout/LeftRail —— 左侧竖排工具栏（classic 布局）。
 * 折叠态只显示窄条 + PanelToggle 展开按钮。
 *  已接线：7 个工具的真实行为由 `usePointerPaint` 接管，Tooltip 展示各自快捷键。
 */
import { usePdbStore } from '@/store';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { PdbIcon, TOOL_ICONS, TOOL_LABELS, TOOL_HINTS } from '@/components/icons';
import { TOOL_HOTKEYS } from '@/hooks/hotkeyMap';
import { PanelToggle } from './PanelToggle';
import { BrushSizeControl } from './Toolbar';
import type { ToolId } from '@/core/types';

const TOOLS = Object.keys(TOOL_ICONS) as ToolId[];

export interface LeftRailProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function LeftRail({ collapsed, onToggle }: LeftRailProps) {
  const tool = usePdbStore((s) => s.tool);
  const setTool = usePdbStore((s) => s.setTool);

  return (
    <aside className={`pdb-left-rail pdb-panel-anim ${collapsed ? 'is-collapsed' : ''}`} aria-label="工具栏">
      <PanelToggle side="left" collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <div className="pdb-left-rail__tools">
          {TOOLS.map((t) => (
            <Tooltip key={t} label={`${TOOL_LABELS[t]} · ${TOOL_HINTS[t]} (${TOOL_HOTKEYS[t]})`} side="right">
              <Button
                icon
                variant={tool === t ? 'soft' : 'ghost'}
                aria-label={TOOL_LABELS[t]}
                aria-pressed={tool === t}
                onClick={() => setTool(t)}
              >
                <PdbIcon name={TOOL_ICONS[t]!} size={18} />
              </Button>
            </Tooltip>
          ))}
          {/* 笔刷大小步进器（画笔/橡皮时出现）：从顶栏挪来，工具的属件跟工具走 */}
          <BrushSizeControl vertical />
          <div className="pdb-left-rail__sep" aria-hidden />
          {/* 同色替换的自选入口：直接在画布上点击则是「点击格颜色 → 当前色」 */}
          <div className="pdb-left-rail__extra">
            <Tooltip label="自选同色替换 · 指定一个源颜色，全图批量换成当前色" side="right">
              <Button
                icon
                variant="ghost"
                aria-label="自选同色替换"
                onClick={() => window.dispatchEvent(new CustomEvent('pdb:open-replace-color'))}
              >
                <PdbIcon name="color" size={18} />
              </Button>
            </Tooltip>
            {/* 外部图纸色号清单：粘贴「色号 数量」清单 → 对到当前色板 + 用量合计 */}
            <Tooltip label="色号清单 · 粘贴别人图纸的用料清单，对色号并算用量" side="right">
              <Button
                icon
                variant="ghost"
                aria-label="色号清单"
                onClick={() => window.dispatchEvent(new CustomEvent('pdb:open-beadlist'))}
              >
                <PdbIcon name="chart" size={18} />
              </Button>
            </Tooltip>
            {/* 图纸 Web：从 Reddit 拼豆社区检索现成图纸，一键导入像素化管线 */}
            <Tooltip label="图纸 Web · 从 Reddit 拼豆社区搜索现成图纸导入（需联网，海外站可能要代理）" side="right">
              <Button
                icon
                variant="ghost"
                aria-label="图纸 Web"
                onClick={() => window.dispatchEvent(new CustomEvent('pdb:open-pattern-web'))}
              >
                <PdbIcon name="search" size={18} />
              </Button>
            </Tooltip>
            {/* 智能拼豆板：本机当板子（虚拟板）——手机 App 连电脑点色号，图案实时上页面。
                2026-09-30 起此入口直开虚拟板（原先指向连真板子的蓝牙探测，已挪到 开始面板→实验功能）。 */}
            <Tooltip label="智能拼豆板 · 本机当板子：手机 App 连接后点色号，页面右下角小窗亮图案（可上主画布）" side="right">
              <Button
                icon
                variant="ghost"
                aria-label="智能拼豆板"
                onClick={() => window.dispatchEvent(new CustomEvent('pdb:open-virtualboard'))}
              >
                <PdbIcon name="monitor" size={18} />
              </Button>
            </Tooltip>
            {/* 手机投图：局域网服务 + 二维码，手机扫码上传图案直接落板 */}
            <Tooltip label="手机投图 · 手机连同一 WiFi 扫码上传图案（图 A 进导入向导 / 图 B 自动落图）" side="right">
              <Button
                icon
                variant="ghost"
                aria-label="手机投图"
                onClick={() => window.dispatchEvent(new CustomEvent('pdb:open-cast'))}
              >
                <PdbIcon name="import" size={18} />
              </Button>
            </Tooltip>
            {/* 「虚拟板」曾一度降级到开始面板实验区；2026-09-30 起侧栏入口回归——
                直开虚拟板（手机 App 联调已端到端跑通，图案可显示在页面小窗/主画布），
                旧的真板子蓝牙探测（SmartBoardDialog）收纳到 开始面板→实验功能。 */}
          </div>
        </div>
      )}
    </aside>
  );
}
