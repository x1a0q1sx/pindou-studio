/**
 * layout/RightPanel —— 右侧面板（classic/floating）：颜色 / 进度 / 板参数 三页签。
 *  已接入：BoardParamsForm + PresetChips + CalibrationWizard。
 *  已接入：颜色页签 = PalettePicker + ColorSwatchList（内嵌 ColorEditor / PaletteManager / EyedropperButton）。
 *  已接入：进度页签 = FilterControls + ColorProgressList + PlacementBar(inline) + PlacementSettings + MiniMap + RegionNavigator。
 */
import { useState } from 'react';
import { Tabs } from '@/components/ui/Tabs';
import { PanelToggle } from './PanelToggle';
import { BoardParamsForm } from '@/components/board/BoardParamsForm';
import { CalibrationWizard } from '@/components/board/CalibrationWizard';
import { RegionNavigator } from '@/components/canvas/RegionNavigator';
import { MiniMap } from '@/components/canvas/MiniMap';
import { PalettePicker } from '@/components/palette/PalettePicker';
import { ColorSwatchList } from '@/components/palette/ColorSwatchList';
import { FilterControls } from '@/components/progress/FilterControls';
import { ColorProgressList } from '@/components/progress/ColorProgressList';
import { PlacementBar } from '@/components/progress/PlacementBar';
import { PlacementSettings } from '@/components/progress/PlacementSettings';
import { SourceAssetPanel } from '@/components/project/SourceAssetPanel';

type TabId = 'colors' | 'progress' | 'board' | 'calibrate' | 'assets';

export interface RightPanelProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function RightPanel({ collapsed, onToggle }: RightPanelProps) {
  const [tab, setTab] = useState<TabId>('colors');

  return (
    <aside className={`pdb-right-panel pdb-panel-anim ${collapsed ? 'is-collapsed' : ''}`} aria-label="侧面板">
      <PanelToggle side="right" collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <>
          <Tabs<TabId>
            items={[
              { id: 'colors', label: '颜色', title: '调色板切换、选色 / 编辑颜色、自定义色' },
              { id: 'progress', label: '进度', title: '按色筛选、逐色拼豆进度与分区导航' },
              { id: 'board', label: '板参数', title: '行列数、钉距、豆点样式、网格与编号' },
              { id: 'calibrate', label: '校准', title: '屏幕物理尺寸校准（自动检测 / 标尺 / 实测跨度）' },
              { id: 'assets', label: '素材', title: '导入的源图素材与裁剪参数' },
            ]}
            active={tab}
            onChange={setTab}
          />
          <div className="pdb-right-panel__body">
            {tab === 'colors' && <ColorsTab />}
            {tab === 'progress' && <ProgressTab />}
            {tab === 'board' && <BoardParamsForm />}
            {tab === 'calibrate' && <CalibrationWizard />}
            {tab === 'assets' && <SourceAssetPanel />}
          </div>
        </>
      )}
    </aside>
  );
}

/* ---------------- 颜色页签（调色板切换 + 颜色列表） ---------------- */

function ColorsTab() {
  return (
    <div className="pdb-colors-tab">
      <PalettePicker />
      <ColorSwatchList />
    </div>
  );
}

/* ---------------- 进度页签（：筛选 + 逐色进度 + 拼豆信息条 + 设置 + 缩略图/区块导航） ---------------- */

function ProgressTab() {
  return (
    <div className="pdb-progress-tab">
      <PlacementBar variant="inline" />
      <FilterControls />
      <ColorProgressList />
      <PlacementSettings />
      <div style={{ width: '100%', marginTop: 8 }}>
        <MiniMap />
      </div>
      <div style={{ width: '100%', marginTop: 8 }}>
        <RegionNavigator />
      </div>
    </div>
  );
}
