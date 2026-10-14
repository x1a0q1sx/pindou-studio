/**
 * icons/index.tsx —— 手绘圆头风 inline SVG 图标库（契约：约 30+ 个，覆盖全部工具与操作）。
 * 统一规格：viewBox 24×24 · strokeWidth 1.75 · linecap/linejoin round · fill none · stroke=currentColor。
 * 不依赖任何图标库；后续任务用 <PdbIcon name="..." /> 或直接 import 单个组件。
 */
import type { JSX, ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function makeIcon(displayName: string, body: ReactNode) {
  function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

/* ================= 工具（ToolId 七件套 + markPlaced） ================= */

export const IconBrush = makeIcon('IconBrush', (
  <>
    <path d="m14.2 4.6 5.2 5.2-7.7 7.7-5.2-5.2 7.7-7.7Z" />
    <path d="m6.5 12.3-1.9 5.5a1.8 1.8 0 0 0 2.3 2.3l5.5-1.9" />
    <path d="m11.6 7.2 5.2 5.2" />
  </>
));

export const IconEraser = makeIcon('IconEraser', (
  <>
    <path d="m6.5 14.5 6-6a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3l-6 6H8.8l-2.3-2.3a2.1 2.1 0 0 1 0-3Z" />
    <path d="m9.5 11.5 3.5 3.5" />
    <path d="M5 20.5h14" />
  </>
));

export const IconFill = makeIcon('IconFill', (
  <>
    <path d="M10.9 3.6 4.4 10.1a1.4 1.4 0 0 0 0 2l6 6a1.4 1.4 0 0 0 2 0l6.5-6.5a1.4 1.4 0 0 0 0-2l-6-6a1.4 1.4 0 0 0-2 0Z" />
    <path d="m7.6 7.9 7.8 7.8" />
    <path d="M19.9 16.9s1.8 2.2 1.8 3.4a1.8 1.8 0 1 1-3.6 0c0-1.2 1.8-3.4 1.8-3.4Z" />
  </>
));

export const IconReplaceColor = makeIcon('IconReplaceColor', (
  <>
    <path d="M4 9.5A6.5 6.5 0 0 1 10.5 3H15" />
    <path d="m12.6 6 2.6-3 2.6 3" />
    <path d="M20 14.5A6.5 6.5 0 0 1 13.5 21H9" />
    <path d="m11.4 18-2.6 3-2.6-3" />
  </>
));

export const IconPicker = makeIcon('IconPicker', (
  <>
    <circle cx="12" cy="12" r="2.9" />
    <path d="M12 3.2v3.2M12 17.6v3.2M3.2 12h3.2M17.6 12h3.2" />
    <path d="m5.8 5.8 2.3 2.3M15.9 15.9l2.3 2.3M18.2 5.8l-2.3 2.3M8.1 15.9l-2.3 2.3" />
  </>
));

export const IconHand = makeIcon('IconHand', (
  <>
    <path d="M9 11V5.6a1.6 1.6 0 0 1 3.2 0V11" />
    <path d="M12.2 10.6V4.9a1.6 1.6 0 0 1 3.2 0v5.9" />
    <path d="M15.4 11.2V7.4a1.6 1.6 0 0 1 3.2 0V15a6 6 0 0 1-6 6h-1.3a5.4 5.4 0 0 1-4.2-2L4 14.8a1.7 1.7 0 0 1 2.6-2.1L9 15" />
  </>
));

export const IconCheckCircle = makeIcon('IconCheckCircle', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.2 12.3 2.6 2.6 5-5.4" />
  </>
));

/* ================= 历史 ================= */

export const IconUndo = makeIcon('IconUndo', (
  <>
    <path d="M4.5 9.5h9a5.5 5.5 0 0 1 0 11h-3.4" />
    <path d="m8 5.5-3.5 4 3.5 4" />
  </>
));

export const IconRedo = makeIcon('IconRedo', (
  <>
    <path d="M19.5 9.5h-9a5.5 5.5 0 0 0 0 11h3.4" />
    <path d="m16 5.5 3.5 4-3.5 4" />
  </>
));

/* ================= 文件 ================= */

export const IconImport = makeIcon('IconImport', (
  <>
    <path d="M12 3.5v10" />
    <path d="m8.2 9.8 3.8 3.7 3.8-3.7" />
    <path d="M4.5 15v3.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7V15" />
  </>
));

export const IconExport = makeIcon('IconExport', (
  <>
    <path d="M12 14V3.8" />
    <path d="m8.2 7.5 3.8-3.7 3.8 3.7" />
    <path d="M4.5 15v3.8a1.7 1.7 0 0 0 1.7 1.7h11.6a1.7 1.7 0 0 0 1.7-1.7V15" />
  </>
));

export const IconSave = makeIcon('IconSave', (
  <>
    <path d="M5.5 4.5h10.7L19.5 7.8v11.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z" />
    <path d="M8.4 4.5v4.7h6.3V4.5" />
    <path d="M8.4 20.5v-5.3h7.2v5.3" />
  </>
));

export const IconFolderOpen = makeIcon('IconFolderOpen', (
  <>
    <path d="M3.5 18.5V6.7a1.2 1.2 0 0 1 1.2-1.2h4l2 2.4h7.4a1.2 1.2 0 0 1 1.2 1.2v2" />
    <path d="m3.5 18.5 2.3-6.2a1.2 1.2 0 0 1 1.1-.8h13.8l-2.3 6.2a1.2 1.2 0 0 1-1.1.8H4.7a1.2 1.2 0 0 1-1.2-1.2Z" />
  </>
));

/* ================= 应用 ================= */

export const IconSettings = makeIcon('IconSettings', (
  <>
    <circle cx="12" cy="12" r="2.9" />
    <path d="M12 3.4v2.2M12 18.4v2.2M20.6 12h-2.2M5.6 12H3.4M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6M18.1 18.1l-1.6-1.6M7.5 7.5 5.9 5.9" />
  </>
));

export const IconTheme = makeIcon('IconTheme', (
  <>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.9-.9 1.9-1.9 0-1.6-1.3-2-.9-3.1.3-.8 1.1-1.2 2.2-1.2h1.4a3.9 3.9 0 0 0 3.9-3.9C20.5 6.6 16.7 3.5 12 3.5Z" />
    <circle cx="8.2" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.8" cy="10" r="1.1" fill="currentColor" stroke="none" />
  </>
));

export const IconLayout = makeIcon('IconLayout', (
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
    <path d="M3.5 9.2h17" />
    <path d="M9.4 9.2v10.3" />
  </>
));

export const IconFullscreen = makeIcon('IconFullscreen', (
  <>
    <path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9" />
    <path d="M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9" />
    <path d="M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15" />
    <path d="M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15" />
  </>
));

export const IconFullscreenExit = makeIcon('IconFullscreenExit', (
  <>
    <path d="M9 4v3.4A1.6 1.6 0 0 1 7.4 9H4" />
    <path d="M20 9h-3.4A1.6 1.6 0 0 1 15 7.4V4" />
    <path d="M15 20v-3.4a1.6 1.6 0 0 1 1.6-1.6H20" />
    <path d="M4 15h3.4A1.6 1.6 0 0 1 9 16.6V20" />
  </>
));

export const IconZoomIn = makeIcon('IconZoomIn', (
  <>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m15.6 15.6 4.2 4.2" />
    <path d="M8.3 10.8h5M10.8 8.3v5" />
  </>
));

export const IconZoomOut = makeIcon('IconZoomOut', (
  <>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m15.6 15.6 4.2 4.2" />
    <path d="M8.3 10.8h5" />
  </>
));

export const IconGrid = makeIcon('IconGrid', (
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.2" />
    <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" />
  </>
));

export const IconBlocks = makeIcon('IconBlocks', (
  <>
    <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.8" />
    <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.8" />
    <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.8" />
    <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.8" />
  </>
));

export const IconChart = makeIcon('IconChart', (
  <>
    <path d="M4 20h16" />
    <rect x="5.5" y="12" width="3.4" height="5.4" rx="1" />
    <rect x="10.3" y="8" width="3.4" height="9.4" rx="1" />
    <rect x="15.1" y="4.6" width="3.4" height="12.8" rx="1" />
  </>
));

export const IconColor = makeIcon('IconColor', (
  <>
    <path d="M12 3.4s6.4 6.8 6.4 11.2a6.4 6.4 0 1 1-12.8 0C5.6 10.2 12 3.4 12 3.4Z" />
    <path d="M9.6 14.8a2.6 2.6 0 0 0 2.6 2.6" />
  </>
));

export const IconBead = makeIcon('IconBead', (
  <>
    <circle cx="12" cy="12" r="7.6" />
    <circle cx="12" cy="12" r="2.2" />
  </>
));

/* ================= 编辑操作 ================= */

export const IconTrash = makeIcon('IconTrash', (
  <>
    <path d="M4.8 6.9h14.4" />
    <path d="M9.2 6.9V5.3a1.6 1.6 0 0 1 1.6-1.6h2.4a1.6 1.6 0 0 1 1.6 1.6v1.6" />
    <path d="M6.6 6.9 7.5 19a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.1" />
    <path d="M10.3 10.4v6.2M13.7 10.4v6.2" />
  </>
));

export const IconPlus = makeIcon('IconPlus', (
  <>
    <path d="M12 4.8v14.4M4.8 12h14.4" />
  </>
));

export const IconMinus = makeIcon('IconMinus', (
  <path d="M4.8 12h14.4" />
));

export const IconPencil = makeIcon('IconPencil', (
  <>
    <path d="m14.6 5.9 3.5 3.5" />
    <path d="M5 19l.9-3.8L15.7 5.4a1.7 1.7 0 0 1 2.4 0l1.5 1.5a1.7 1.7 0 0 1 0 2.4L9.8 19.1 5 19Z" />
  </>
));

export const IconClose = makeIcon('IconClose', (
  <>
    <path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8" />
  </>
));

export const IconWindowMax = makeIcon('IconWindowMax', (
  <rect x="5.7" y="5.7" width="12.6" height="12.6" rx="1.6" />
));

export const IconWindowRestore = makeIcon('IconWindowRestore', (
  <>
    <rect x="4.8" y="8.4" width="10.8" height="10.8" rx="1.4" />
    <path d="M8.4 5.5h7.3a2.8 2.8 0 0 1 2.8 2.8v7.3" />
  </>
));

export const IconChevronUp = makeIcon('IconChevronUp', <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />);
export const IconChevronDown = makeIcon('IconChevronDown', <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />);
export const IconChevronLeft = makeIcon('IconChevronLeft', <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />);
export const IconChevronRight = makeIcon('IconChevronRight', <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />);

/* ================= 状态提示 ================= */

export const IconWarning = makeIcon('IconWarning', (
  <>
    <path d="M12 4.4 2.9 19.1a1.1 1.1 0 0 0 1 1.6h16.2a1.1 1.1 0 0 0 1-1.6L13 4.4a1.2 1.2 0 0 0-1 0Z" />
    <path d="M12 9.6v4.2" />
    <circle cx="12" cy="17.1" r="0.6" fill="currentColor" stroke="none" />
  </>
));

export const IconInfo = makeIcon('IconInfo', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.4" />
    <circle cx="12" cy="7.9" r="0.6" fill="currentColor" stroke="none" />
  </>
));

export const IconSuccess = IconCheckCircle; // 语义别名：Toast success 用

/* ================= 其他 ================= */

export const IconMonitor = makeIcon('IconMonitor', (
  <>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M9 20.5h6M12 16.5v4" />
  </>
));

export const IconRuler = makeIcon('IconRuler', (
  <>
    <rect x="2.4" y="8.4" width="19.2" height="7.2" rx="1.6" />
    <path d="M6.4 8.4v2.8M10 8.4v4M13.6 8.4v2.8M17.2 8.4v4" />
  </>
));

export const IconCopy = makeIcon('IconCopy', (
  <>
    <rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2" />
    <path d="M15.4 5.6a2 2 0 0 0-2-1.6H6a2 2 0 0 0-2 2v7.4a2 2 0 0 0 1.6 2" />
  </>
));

export const IconSearch = makeIcon('IconSearch', (
  <>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m15.6 15.6 4.2 4.2" />
  </>
));

export const IconDrag = makeIcon('IconDrag', (
  <>
    <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
  </>
));

/* ================= 名称索引（供 Toolbar/LeftRail 按字符串取用） ================= */

export const ICONS = {
  brush: IconBrush,
  eraser: IconEraser,
  fill: IconFill,
  replaceColor: IconReplaceColor,
  picker: IconPicker,
  hand: IconHand,
  checkCircle: IconCheckCircle,
  undo: IconUndo,
  redo: IconRedo,
  import: IconImport,
  export: IconExport,
  save: IconSave,
  folderOpen: IconFolderOpen,
  settings: IconSettings,
  theme: IconTheme,
  layout: IconLayout,
  fullscreen: IconFullscreen,
  fullscreenExit: IconFullscreenExit,
  zoomIn: IconZoomIn,
  zoomOut: IconZoomOut,
  grid: IconGrid,
  blocks: IconBlocks,
  chart: IconChart,
  color: IconColor,
  bead: IconBead,
  trash: IconTrash,
  plus: IconPlus,
  minus: IconMinus,
  pencil: IconPencil,
  close: IconClose,
  windowMax: IconWindowMax,
  windowRestore: IconWindowRestore,
  chevronUp: IconChevronUp,
  chevronDown: IconChevronDown,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  warning: IconWarning,
  info: IconInfo,
  success: IconSuccess,
  monitor: IconMonitor,
  ruler: IconRuler,
  copy: IconCopy,
  search: IconSearch,
  drag: IconDrag,
} as const;

export type IconName = keyof typeof ICONS;

/** 按名称渲染图标（<PdbIcon name="save" size={18}/>） */
export function PdbIcon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>): JSX.Element {
  const Cmp = ICONS[name];
  return <Cmp size={size} {...rest} />;
}

/** ToolId → 图标 映射（LeftRail/Toolbar 共用， 工具面板也按此对齐） */
export const TOOL_ICONS: Record<string, IconName> = {
  pen: 'brush',
  eraser: 'eraser',
  flood: 'fill',
  replaceColor: 'replaceColor',
  picker: 'picker',
  pan: 'hand',
  markPlaced: 'checkCircle',
};

export const TOOL_LABELS: Record<string, string> = {
  pen: '画笔',
  eraser: '橡皮',
  flood: '连通填充',
  replaceColor: '同色替换',
  picker: '取色',
  pan: '平移',
  markPlaced: '标记已放',
};

/** 工具用途说明（Tooltip 第二段：名称 · 用途 · 快捷键）。 */
export const TOOL_HINTS: Record<string, string> = {
  pen: '在格子上涂当前颜色，拖拽连续绘制不断线',
  eraser: '擦除格子上的豆子，恢复为空格',
  flood: '把与点击格同色的相连区域整体填充为当前色',
  replaceColor: '把全图与点击格相同的颜色批量替换为当前色',
  picker: '从画布格子吸取颜色，设为当前色',
  pan: '拖拽平移画布视图（按住 Space 可随时临时平移）',
  markPlaced: '点击格子记下「这一颗已物理放到板上」，按色计数实时递减',
};
