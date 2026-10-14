/**
 * palettes/perler.ts —— Perler 拼豆色板（67 色，5mm 标准豆）。
 *
 * 数据来源：
 * - 57 色（P01–P105 在售全系）：pixel-beads.com 色表核实 HEX（2026 修订版，
 *   页面自述 57 = 47 核心 + 6 珍珠 + 4 荧光）；
 * - 另补 10 个常见色号（P22–P55 段）：官方未在该表收录（停产/别名批次），
 *   按**颜色名称语义 + 邻近核实色插值**推导。
 * ⚠ 项目需求提及的 `80-19001`/`PER17666` 为零售商 SKU 编号（约 124 项含停产与
 *   SKU 变体），指定数据源 pixel-beads.com 采用 P 码体系且仅收录在售色，故从源。
 * ⚠ 批次间有差异，可用颜色编辑器 + 吸管实测校正。数据只写 hex，rgb/lab 由 index.ts hydrate。
 */
import type { BeadColorInput } from './types';

/** [code, name(英), nameZh(中), hex, verified(1=核实/0=名称推导), series] */
type Row = [string, string, string, string, 1 | 0, string];

const CORE = '核心系列 Core';
const PEARL = '珍珠系列 Pearl';
const NEON = '荧光系列 Neon';
const EXTRA = '补充色号（名称推导）';

const ROWS: Row[] = [
  ['P01', 'White', '白色', '#F1F1F1', 1, CORE],
  ['P02', 'Cream', '奶油', '#E0DEA9', 1, CORE],
  ['P03', 'Yellow', '黄色', '#ECD800', 1, CORE],
  ['P04', 'Orange', '橙色', '#ED6120', 1, CORE],
  ['P05', 'Red', '红色', '#F01820', 1, CORE],
  ['P06', 'Bubblegum', '泡泡糖', '#DD669B', 1, CORE],
  ['P07', 'Purple', '紫色', '#604089', 1, CORE],
  ['P08', 'Dark Blue', '深蓝', '#2B3F87', 1, CORE],
  ['P09', 'Light Blue', '浅蓝', '#3370C0', 1, CORE],
  ['P10', 'Dark Green', '深绿', '#1C753E', 1, CORE],
  ['P11', 'Light Green', '浅绿', '#56BA9F', 1, CORE],
  ['P12', 'Brown', '棕色', '#513931', 1, CORE],
  ['P17', 'Gray', '灰色', '#8A8D91', 1, CORE],
  ['P18', 'Black', '黑色', '#2E2F32', 1, CORE],
  ['P20', 'Rust', '铁锈', '#8C372C', 1, CORE],
  ['P21', 'Light Brown', '浅棕', '#815D34', 1, CORE],
  ['P33', 'Peach', '蜜桃', '#EEBAB2', 1, CORE],
  ['P35', 'Tan', '棕褐', '#BC9371', 1, CORE],
  ['P38', 'Magenta', '洋红', '#F22A7B', 1, CORE],
  ['P48', 'Neon Orange', '霓虹橙', '#FF7700', 1, NEON],
  ['P47', 'Neon Yellow', '霓虹黄', '#DCE002', 1, NEON],
  ['P49', 'Neon Green', '霓虹绿', '#019E43', 1, NEON],
  ['P50', 'Neon Pink', '霓虹粉', '#FF3991', 1, NEON],
  ['P52', 'Pastel Blue', '粉彩蓝', '#5390D1', 1, CORE],
  ['P53', 'Pastel Green', '粉彩绿', '#76C882', 1, CORE],
  ['P56', 'Pastel Yellow', '粉彩黄', '#FEF875', 1, CORE],
  ['P57', 'Cheddar', '切达黄', '#F1AA0C', 1, CORE],
  ['P58', 'Toothpaste', '牙膏蓝', '#93C8D4', 1, CORE],
  ['P59', 'Hot Coral', '热珊瑚', '#FF3851', 1, CORE],
  ['P60', 'Plum', '梅子', '#A24B9C', 1, CORE],
  ['P61', 'Kiwi Lime', '猕猴桃绿', '#6CBE13', 1, CORE],
  ['P62', 'Cyan', '青绿', '#2B89C6', 1, CORE],
  ['P63', 'Blush', '腮红', '#FF8285', 1, CORE],
  ['P70', 'Periwinkle', '长春花蓝', '#647CBE', 1, CORE],
  ['P75', 'Glow Green', '夜光绿', '#BEC696', 1, CORE],
  ['P79', 'Light Pink', '浅粉', '#F6B3DD', 1, CORE],
  ['P80', 'Bright Green', '亮绿', '#4FAD42', 1, CORE],
  ['P81', 'Eggshell', '蛋壳白', '#EEE3CF', 1, CORE],
  ['P83', 'Pink', '粉色', '#E44892', 1, CORE],
  ['P85', 'Gold', '金色', '#BB7634', 1, CORE],
  ['P88', 'Raspberry', '覆盆子', '#A53061', 1, CORE],
  ['P90', 'Butterscotch', '奶油糖', '#D48437', 1, CORE],
  ['P91', 'Parrot Green', '鹦鹉绿', '#067C81', 1, CORE],
  ['P92', 'Dark Gray', '深灰', '#4D5156', 1, CORE],
  ['P93', 'Blueberry Cream', '蓝莓奶油', '#8297D9', 1, CORE],
  ['P96', 'Cranberry', '蔓越莓', '#801922', 1, CORE],
  ['P97', 'Prickly Pear', '仙人掌果', '#BDDA01', 1, CORE],
  ['P98', 'Sand', '沙色', '#E4B690', 1, CORE],
  ['P100', 'Pearl Coral', '珍珠珊瑚', '#F97E79', 1, PEARL],
  ['P101', 'Pearl Light Blue', '珍珠浅蓝', '#7AAEA2', 1, PEARL],
  ['P102', 'Pearl Green', '珍珠绿', '#84B791', 1, PEARL],
  ['P103', 'Pearl Yellow', '珍珠黄', '#CAC033', 1, PEARL],
  ['P104', 'Pearl Light Pink', '珍珠浅粉', '#D7A8A2', 1, PEARL],
  ['P105', 'Pearl Silver', '珍珠银', '#777B81', 1, PEARL],
  ['P179', 'Evergreen', '常青绿', '#114938', 1, CORE],
  // ---- 补充色号（12，名称推导）----
  ['P22', 'Lavender', '薰衣草', '#AD98D4', 0, EXTRA],
  ['P23', 'Orchid', '兰花紫', '#B78FD1', 0, EXTRA],
  ['P24', 'Eggplant', '茄紫', '#4A2C5E', 0, EXTRA],
  ['P25', 'Dark Brown', '深棕', '#3E2A21', 0, EXTRA],
  ['P27', 'Light Gray', '浅灰', '#C3C6C9', 0, EXTRA],
  ['P31', 'Cherry', '樱桃红', '#C21E2C', 0, EXTRA],
  ['P34', 'Shell', '贝壳粉', '#F7D9C9', 0, EXTRA],
  ['P36', 'Fern', '蕨绿', '#3E7A3E', 0, EXTRA],
  ['P37', 'Robin Egg', '知更鸟蛋蓝', '#8FD8E0', 0, EXTRA],
  ['P51', 'Neon Blue', '霓虹蓝', '#2D72E8', 0, EXTRA],
  ['P54', 'Pastel Lavender', '粉彩薰衣草', '#8A72C1', 0, EXTRA],
  ['P55', 'Pastel Pink', '粉彩粉', '#F7A8C4', 0, EXTRA],
];

export const PERLER_COLORS: BeadColorInput[] = ROWS.map(([code, name, nameZh, hex, , series]) => ({
  id: `perler-${code}`,
  code,
  name,
  nameZh,
  hex,
  series,
  builtin: true,
}));
