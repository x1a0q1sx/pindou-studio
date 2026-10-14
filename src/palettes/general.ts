/**
 * palettes/general.ts —— 通用拼豆色板（96 色，默认色板）。
 *
 * 设计目标：不绑定任何品牌、市面常见 5mm/2.6mm 通用豆都能找到近似色，
 * 专为渐变作品设计 —— 九大色族，每族含「浅 → 中 → 深」阶梯。
 * 色号规则：G-<族码><两位序号>
 *   W 白灰黑 / R 红粉 / O 橙黄 / G 绿 / B 蓝 / P 紫 / N 棕肤 / F 荧光 / T 透明
 * 数据只写 hex；rgb/lab 由 index.ts hydrate 时统一计算。
 * 透明族 T 为视觉参考值（半透明豆叠白底后的近似呈色）。
 */
import type { BeadColorInput } from './types';

/** [code, name(英), nameZh(中), hex, series, seriesZh] */
type Row = [string, string, string, string, string, string];

const S = {
  W: ['White & Gray', '白灰黑'],
  R: ['Red & Pink', '红粉'],
  O: ['Orange & Yellow', '橙黄'],
  G: ['Green', '绿'],
  B: ['Blue', '蓝'],
  P: ['Purple', '紫'],
  N: ['Brown & Skin', '棕肤'],
  F: ['Fluorescent', '荧光'],
  T: ['Transparent', '透明'],
} as const;

const ROWS: Row[] = [
  // ---- W 白灰黑（12）----
  ['G-W01', 'Snow White',      '雪白',   '#FFFFFF', ...S.W],
  ['G-W02', 'Milk White',      '奶白',   '#F7F4EC', ...S.W],
  ['G-W03', 'Ivory',           '象牙白', '#EFE9DA', ...S.W],
  ['G-W04', 'Pearl Gray',      '珍珠灰', '#DCDCDC', ...S.W],
  ['G-W05', 'Light Gray',      '浅灰',   '#C2C2C2', ...S.W],
  ['G-W06', 'Silver Gray',     '银灰',   '#A6A6A6', ...S.W],
  ['G-W07', 'Medium Gray',     '中灰',   '#8A8A8A', ...S.W],
  ['G-W08', 'Gray',            '灰',     '#6E6E6E', ...S.W],
  ['G-W09', 'Dark Gray',       '深灰',   '#545454', ...S.W],
  ['G-W10', 'Charcoal',        '炭灰',   '#3B3B3B', ...S.W],
  ['G-W11', 'Ink',             '墨黑',   '#232323', ...S.W],
  ['G-W12', 'Jet Black',       '纯黑',   '#0A0A0A', ...S.W],
  // ---- R 红粉（14）----
  ['G-R01', 'Blush Pink',      '淡粉',   '#FFE3E8', ...S.R],
  ['G-R02', 'Baby Pink',       '嫩粉',   '#FFC9D4', ...S.R],
  ['G-R03', 'Peach Pink',      '蜜桃粉', '#FFB0BE', ...S.R],
  ['G-R04', 'Coral Pink',      '珊瑚粉', '#FF8FA3', ...S.R],
  ['G-R05', 'Rose',            '玫瑰红', '#F2607D', ...S.R],
  ['G-R06', 'Strawberry',      '草莓红', '#E63E62', ...S.R],
  ['G-R07', 'True Red',        '正红',   '#D92537', ...S.R],
  ['G-R08', 'Cherry',          '樱桃红', '#B31B2E', ...S.R],
  ['G-R09', 'Brick Red',       '砖红',   '#8F1D28', ...S.R],
  ['G-R10', 'Wine Red',        '酒红',   '#6B1220', ...S.R],
  ['G-R11', 'Hot Pink',        '亮粉',   '#FF4F9A', ...S.R],
  ['G-R12', 'Magenta',         '洋红',   '#D6237F', ...S.R],
  ['G-R13', 'Salmon Pink',     '三文鱼粉', '#FF9E80', ...S.R],
  ['G-R14', 'Bean Paste',      '豆沙',   '#A34A5E', ...S.R],
  // ---- O 橙黄（14）----
  ['G-O01', 'Cream Yellow',    '奶油黄', '#FFF6D8', ...S.O],
  ['G-O02', 'Lemon Chiffon',   '柠檬纱', '#FFEF9E', ...S.O],
  ['G-O03', 'Butter',          '黄油',   '#FFE270', ...S.O],
  ['G-O04', 'Lemon',           '柠檬黄', '#FFD62E', ...S.O],
  ['G-O05', 'Sunflower',       '向日葵', '#FFC300', ...S.O],
  ['G-O06', 'Amber',           '琥珀',   '#F5A800', ...S.O],
  ['G-O07', 'Golden',          '金黄',   '#E39400', ...S.O],
  ['G-O08', 'Apricot Orange',  '杏橙',   '#FF9A3D', ...S.O],
  ['G-O09', 'Tangerine',       '橘色',   '#FF7A1A', ...S.O],
  ['G-O10', 'Pumpkin',         '南瓜橙', '#EE6411', ...S.O],
  ['G-O11', 'Burnt Orange',    '焦橙',   '#C74E12', ...S.O],
  ['G-O12', 'Rust',            '铁锈',   '#9C4313', ...S.O],
  ['G-O13', 'Champagne',       '香槟',   '#F2E3C4', ...S.O],
  ['G-O14', 'Honey',           '蜂蜜',   '#EBA83C', ...S.O],
  // ---- G 绿（14）----
  ['G-G01', 'Mint Cream',      '薄荷奶', '#E4F7E9', ...S.G],
  ['G-G02', 'Pale Mint',       '淡薄荷', '#C6EFD2', ...S.G],
  ['G-G03', 'Sprout',          '嫩芽绿', '#A8E6A1', ...S.G],
  ['G-G04', 'Matcha',          '抹茶',   '#8FD14F', ...S.G],
  ['G-G05', 'Fresh Green',     '鲜绿',   '#5FBE5B', ...S.G],
  ['G-G06', 'Grass Green',     '草绿',   '#3FA535', ...S.G],
  ['G-G07', 'Leaf Green',      '叶绿',   '#2E8B34', ...S.G],
  ['G-G08', 'Deep Green',      '深绿',   '#1F6B32', ...S.G],
  ['G-G09', 'Pine Green',      '松绿',   '#1D5038', ...S.G],
  ['G-G10', 'Olive',           '橄榄绿', '#7A7A32', ...S.G],
  ['G-G11', 'Avocado',         '牛油果', '#5A7247', ...S.G],
  ['G-G12', 'Turquoise Green', '蓝绿',   '#28B9A1', ...S.G],
  ['G-G13', 'Jade',            '青玉',   '#1FA37C', ...S.G],
  ['G-G14', 'Peacock Green',   '孔雀绿', '#0E7C6B', ...S.G],
  // ---- B 蓝（14）----
  ['G-B01', 'Ice Blue',        '冰蓝',   '#E4F4FF', ...S.B],
  ['G-B02', 'Sky Mist',        '天空雾', '#CDE9FB', ...S.B],
  ['G-B03', 'Baby Blue',       '婴儿蓝', '#A7D8F5', ...S.B],
  ['G-B04', 'Light Blue',      '浅蓝',   '#7CC3EE', ...S.B],
  ['G-B05', 'Lake Blue',       '湖蓝',   '#4FA8E0', ...S.B],
  ['G-B06', 'Sky Blue',        '天蓝',   '#2E8FD6', ...S.B],
  ['G-B07', 'Cobalt Blue',     '钴蓝',   '#1B6FC2', ...S.B],
  ['G-B08', 'Ocean Blue',      '海洋蓝', '#155A9E', ...S.B],
  ['G-B09', 'Deep Sea',        '深海蓝', '#10457A', ...S.B],
  ['G-B10', 'Navy',            '藏青',   '#12315E', ...S.B],
  ['G-B11', 'Midnight',        '午夜蓝', '#0C2140', ...S.B],
  ['G-B12', 'Teal',            '鸭绿青', '#168E9E', ...S.B],
  ['G-B13', 'Denim',           '牛仔蓝', '#4A6FA5', ...S.B],
  ['G-B14', 'Cornflower',      '矢车菊蓝', '#6E8FD1', ...S.B],
  // ---- P 紫（10）----
  ['G-P01', 'Lilac White',     '丁香白', '#F2E9FA', ...S.P],
  ['G-P02', 'Pale Lavender',   '淡薰衣草', '#E2D2F4', ...S.P],
  ['G-P03', 'Lavender',        '薰衣草', '#C9AEE8', ...S.P],
  ['G-P04', 'Taro Purple',     '香芋紫', '#AE8BD8', ...S.P],
  ['G-P05', 'Violet',          '紫罗兰', '#8E63C4', ...S.P],
  ['G-P06', 'Orchid Purple',   '兰花紫', '#7249A8', ...S.P],
  ['G-P07', 'Deep Purple',     '深紫',   '#5A3488', ...S.P],
  ['G-P08', 'Eggplant',        '茄紫',   '#42265E', ...S.P],
  ['G-P09', 'Grape',           '葡萄紫', '#6D4C9F', ...S.P],
  ['G-P10', 'Blue Violet',     '蓝紫',   '#4F46A3', ...S.P],
  // ---- N 棕肤（10）----
  ['G-N01', 'Beige',           '米色',   '#F3E5CE', ...S.N],
  ['G-N02', 'Milk Tea',        '奶茶',   '#E5CBA3', ...S.N],
  ['G-N03', 'Wheat',           '小麦',   '#D9B382', ...S.N],
  ['G-N04', 'Skin',            '肤色',   '#EEC9A6', ...S.N],
  ['G-N05', 'Tan',             '浅棕',   '#B98A5E', ...S.N],
  ['G-N06', 'Camel',           '驼色',   '#A9744F', ...S.N],
  ['G-N07', 'Caramel',         '焦糖',   '#8D5A3A', ...S.N],
  ['G-N08', 'Coffee',          '咖啡',   '#6B442A', ...S.N],
  ['G-N09', 'Dark Brown',      '深棕',   '#4E3120', ...S.N],
  ['G-N10', 'Cocoa',           '可可',   '#38241A', ...S.N],
  // ---- F 荧光（4）----
  ['G-F01', 'Fluorescent Pink',   '荧光粉', '#FF4FD8', ...S.F],
  ['G-F02', 'Fluorescent Orange', '荧光橙', '#FF6A00', ...S.F],
  ['G-F03', 'Fluorescent Yellow', '荧光黄', '#F2FF00', ...S.F],
  ['G-F04', 'Fluorescent Green',  '荧光绿', '#39FF14', ...S.F],
  // ---- T 透明（4，视觉参考值：半透明豆叠白底的近似呈色）----
  ['G-T01', 'Clear',              '透明',   '#F2F5F6', ...S.T],
  ['G-T02', 'Transparent Red',    '透明红', '#F5B3BB', ...S.T],
  ['G-T03', 'Transparent Blue',   '透明蓝', '#B3D4F0', ...S.T],
  ['G-T04', 'Transparent Yellow', '透明黄', '#F7ECB8', ...S.T],
];

export const GENERAL_COLORS: BeadColorInput[] = ROWS.map(([code, name, nameZh, hex, series, seriesZh]) => ({
  id: `general-${code}`,
  code,
  name,
  nameZh,
  hex,
  series: `${series} ${seriesZh}`,
  builtin: true,
}));
