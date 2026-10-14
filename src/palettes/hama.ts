/**
 * palettes/hama.ts —— Hama 拼豆色板（88 色，5mm MIDI 标准豆）。
 *
 * 数据来源：
 * - H01–H49（49 色经典系）：社区色表核实 HEX（缺号的 H14/H15 按透明系命名推导）；
 * - H55–H125 现代扩展（41 色）：按项目需求补充的功能色（夜光/金属/半透明/粉彩/特殊色）
 *   按**颜色名称语义 + 同族核实色的色相/明度科学插值**推导。
 * ⚠ 社区整理/名称推导值，批次间有差异，可用颜色编辑器 + 吸管实测校正。
 * 数据只写 hex；rgb/lab 由 index.ts hydrate 时统一计算。
 */
import type { BeadColorInput } from './types';

/** [code, name(英), nameZh(中), hex, verified(1=核实/0=名称推导), series] */
type Row = [string, string, string, string, 1 | 0, string];

const CL = '经典系列 Classic';
const TR = '透明系列 Transparent';
const NE = '荧光系列 Neon';
const FL = '萤光系列 Fluorescent';
const PA = '粉彩系列 Pastel';
const SP = '特殊系列 Special';
const MO = '现代扩展 Modern';

const ROWS: Row[] = [
  ['H01', 'White', '白色', '#ECEDED', 1, CL],
  ['H02', 'Cream', '奶油', '#F0E8B9', 1, CL],
  ['H03', 'Yellow', '黄色', '#F0B901', 1, CL],
  ['H04', 'Orange', '橙色', '#E64F27', 1, CL],
  ['H05', 'Red', '红色', '#B63136', 1, CL],
  ['H06', 'Pink', '粉色', '#E1889F', 1, CL],
  ['H07', 'Purple', '紫色', '#694A82', 1, CL],
  ['H08', 'Dark Blue', '深蓝', '#2C4690', 1, CL],
  ['H09', 'Light Blue', '浅蓝', '#305CB0', 1, CL],
  ['H10', 'Green', '绿色', '#256847', 1, CL],
  ['H11', 'Light Green', '浅绿', '#49AE89', 1, CL],
  ['H12', 'Brown', '棕色', '#534137', 1, CL],
  ['H13', 'Transparent Red', '透明红', '#C02435', 1, TR],
  ['H14', 'Transparent Yellow', '透明黄', '#E8D44A', 0, TR],
  ['H15', 'Transparent Blue', '透明蓝', '#4A78C8', 0, TR],
  ['H16', 'Transparent Green', '透明绿', '#37B876', 1, TR],
  ['H17', 'Grey', '灰色', '#83888A', 1, CL],
  ['H18', 'Black', '黑色', '#2E2F31', 1, CL],
  ['H19', 'Clear', '透明', '#D8D2CE', 1, TR],
  ['H20', 'Reddish Brown', '红棕', '#7F332A', 1, CL],
  ['H21', 'Light Brown', '浅棕', '#A5693F', 1, CL],
  ['H22', 'Dark Red', '深红', '#A52D36', 1, CL],
  ['H24', 'Translucent Purple', '半透明紫', '#683E9A', 1, TR],
  ['H25', 'Translucent Brown', '半透明棕', '#87593D', 1, TR],
  ['H26', 'Flesh', '肤色', '#DE9B90', 1, CL],
  ['H27', 'Beige', '米色', '#DEB48B', 1, CL],
  ['H28', 'Army Green', '军绿', '#363F38', 1, CL],
  ['H29', 'Claret', '深酒红', '#B9395E', 1, CL],
  ['H30', 'Burgundy', '勃艮第', '#592F38', 1, CL],
  ['H31', 'Turquoise', '松石绿', '#6797AE', 1, CL],
  ['H32', 'Neon Pink', '荧光粉', '#FF208D', 1, NE],
  ['H33', 'Cerise', '樱桃粉', '#FF3956', 1, NE],
  ['H34', 'Neon Yellow', '荧光黄', '#E5EF13', 1, NE],
  ['H35', 'Neon Red', '荧光红', '#FF2833', 1, NE],
  ['H36', 'Neon Blue', '荧光蓝', '#2353B0', 1, NE],
  ['H37', 'Neon Green', '荧光绿', '#06B73C', 1, NE],
  ['H38', 'Neon Orange', '荧光橙', '#FD8600', 1, NE],
  ['H39', 'Fluorescent Yellow', '萤光黄', '#F1F21C', 1, FL],
  ['H40', 'Fluorescent Orange', '萤光橙', '#FE630B', 1, FL],
  ['H41', 'Fluorescent Blue', '萤光蓝', '#2659B2', 1, FL],
  ['H42', 'Fluorescent Green', '萤光绿', '#0CBD51', 1, FL],
  ['H43', 'Pastel Yellow', '粉彩黄', '#F0EA37', 1, PA],
  ['H44', 'Pastel Red', '粉彩红', '#EE6972', 1, PA],
  ['H45', 'Pastel Purple', '粉彩紫', '#886DB9', 1, PA],
  ['H46', 'Pastel Blue', '粉彩蓝', '#629ED7', 1, PA],
  ['H47', 'Pastel Green', '粉彩绿', '#83CB70', 1, PA],
  ['H48', 'Pastel Pink', '粉彩粉', '#CF70B7', 1, PA],
  ['H49', 'Azure', '蔚蓝', '#4998BC', 1, CL],
  // ---- H55 起现代扩展（名称推导）----
  ['H55', 'Glow Green', '夜光绿', '#CDE8A8', 0, SP],
  ['H56', 'Glow Blue', '夜光蓝', '#A8D8E0', 0, SP],
  ['H60', 'Teddybear Brown', '泰迪熊棕', '#8A6248', 0, CL],
  ['H61', 'Gold', '金色', '#C9A24B', 0, SP],
  ['H62', 'Silver', '银色', '#B9BDC2', 0, SP],
  ['H63', 'Bronze', '青铜', '#9A7442', 0, SP],
  ['H64', 'Pearl', '珍珠', '#EDE4DC', 0, SP],
  ['H70', 'Light Grey', '浅灰', '#C4C8CA', 0, CL],
  ['H71', 'Dark Grey', '深灰', '#4E5254', 0, CL],
  ['H72', 'Translucent Red', '半透明红', '#D89A9E', 0, TR],
  ['H73', 'Translucent Yellow', '半透明黄', '#E8DCA0', 0, TR],
  ['H74', 'Translucent Blue', '半透明蓝', '#A8BCD8', 0, TR],
  ['H75', 'Nougat', '牛轧糖', '#E4BFA0', 0, CL],
  ['H76', 'Cloudy White', '云白', '#EFEDE4', 0, CL],
  ['H77', 'Peach', '蜜桃', '#F2C0A4', 0, CL],
  ['H78', 'Apricot', '杏色', '#EDA983', 0, CL],
  ['H79', 'Sand', '沙色', '#D8BE95', 0, CL],
  ['H82', 'Plum', '梅紫', '#6E3A5E', 0, CL],
  ['H83', 'Petrol Blue', '石油蓝', '#2E5E74', 0, CL],
  ['H84', 'Olive Green', '橄榄绿', '#6E7440', 0, CL],
  ['H95', 'Pastel Orange', '粉彩橙', '#F5B98A', 0, PA],
  ['H96', 'Pastel Mint', '粉彩薄荷', '#AEDCC4', 0, PA],
  ['H97', 'Pastel Grey', '粉彩灰', '#D2D4D2', 0, PA],
  ['H98', 'Pastel Beige', '粉彩米', '#E8D8BE', 0, PA],
  ['H101', 'Anthracite', '无烟煤黑', '#3A3E42', 0, MO],
  ['H102', 'Stone Grey', '石灰灰', '#9C9A94', 0, MO],
  ['H103', 'Sandstone', '砂岩', '#D4BC9A', 0, MO],
  ['H104', 'Camel', '驼色', '#B98A5E', 0, MO],
  ['H105', 'Cinnamon', '肉桂', '#9A5E38', 0, MO],
  ['H106', 'Cocoa', '可可', '#5E4234', 0, MO],
  ['H107', 'Terracotta', '陶土', '#C06A4E', 0, MO],
  ['H108', 'Rose', '玫瑰', '#D47A8A', 0, MO],
  ['H109', 'Fuchsia', '紫红', '#C24A8A', 0, MO],
  ['H110', 'Mauve', '木槿紫', '#9A7296', 0, MO],
  ['H111', 'Violet', '紫罗兰', '#5E4280', 0, MO],
  ['H112', 'Denim', '牛仔蓝', '#4A6A96', 0, MO],
  ['H113', 'Steel Blue', '钢青', '#5E849A', 0, MO],
  ['H114', 'Ice Blue', '冰蓝', '#BCD8E4', 0, MO],
  ['H115', 'Mint', '薄荷', '#9AD8BC', 0, MO],
  ['H116', 'Grass Green', '草绿', '#5E9A4A', 0, MO],
];

export const HAMA_COLORS: BeadColorInput[] = ROWS.map(([code, name, nameZh, hex, , series]) => ({
  id: `hama-${code}`,
  code,
  name,
  nameZh,
  hex,
  series,
  builtin: true,
}));
