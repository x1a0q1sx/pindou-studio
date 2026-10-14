/**
 * palette/ColorSwatchList —— 色板颜色列表。
 * 每行 = 拼豆色块 + 色号 + 中英名称 + HEX + 本图用量 + 剩余待放。
 * 用量：遍历一次 beads(Uint16Array，存索引+1) 计数，订阅 beadsVersion 做缓存失效。
 * 能力：搜索（色号/名称/HEX 模糊）、排序（用量/色号/色相/明度）、分组折叠（系列/色相）、
 *   单击设为 activeColorIndex、双击按色筛选、悬停/右键出现「编辑」入口（打开 ColorEditor）。
 * 性能：225 色流畅——用量 useMemo 缓存、行 React.memo、分组折叠减少 DOM、色相/明度预计算。
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { Segmented } from '@/components/ui/Segmented';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import { usePdbStore } from '@/store';
import { rgbToHsl } from '@/color/convert';
import type { BeadColor } from '@/core/types';
import { ColorEditor } from './ColorEditor';
import { EyedropperButton } from './EyedropperButton';
import './palette.css';

type SortKey = 'usage' | 'code' | 'hue' | 'light';
type GroupKey = 'none' | 'series' | 'hue';

interface Row {
  color: BeadColor;
  index: number;
  used: number;
  placed: number;
  hue: number;
  light: number;
}

/* 色相分桶（按 HSL hue 角度归入中文色族；饱和度过低视为中性） */
const HUE_BUCKETS: { name: string; test: (r: Row) => boolean }[] = [
  { name: '中性 Neutral', test: (r) => r.color.rgb[0] === r.color.rgb[1] && r.color.rgb[1] === r.color.rgb[2] },
  { name: '红 Red', test: (r) => r.hue < 15 || r.hue >= 345 },
  { name: '橙 Orange', test: (r) => r.hue >= 15 && r.hue < 45 },
  { name: '黄 Yellow', test: (r) => r.hue >= 45 && r.hue < 70 },
  { name: '绿 Green', test: (r) => r.hue >= 70 && r.hue < 165 },
  { name: '青 Cyan', test: (r) => r.hue >= 165 && r.hue < 200 },
  { name: '蓝 Blue', test: (r) => r.hue >= 200 && r.hue < 255 },
  { name: '紫 Purple', test: (r) => r.hue >= 255 && r.hue < 290 },
  { name: '粉 Pink', test: (r) => r.hue >= 290 && r.hue < 345 },
];

function hueBucket(r: Row): string {
  for (const b of HUE_BUCKETS) if (b.test(r)) return b.name;
  return '其它 Other';
}

/* ---------------- 单行（memo：beadsVersion 变化时仅用量变的行重渲染） ---------------- */

interface ColorRowProps {
  row: Row;
  isActive: boolean;
  isFiltered: boolean;
  onSelect: (i: number) => void;
  onFilter: (i: number) => void;
  onEdit: (i: number) => void;
}

const ColorRow = memo(function ColorRow({ row, isActive, isFiltered, onSelect, onFilter, onEdit }: ColorRowProps) {
  const { color, index, used, placed } = row;
  const remaining = used - placed;
  return (
    <div
      className={`pdb-csl__row ${isActive ? 'is-active' : ''} ${isFiltered ? 'is-filtered' : ''}`}
      role="button"
      tabIndex={0}
      title={`${color.code} ${color.nameZh ?? ''} ${color.name} ${color.hex}\n用量 ${used} · 剩余 ${remaining} · 单击选色 · 双击筛选`}
      onClick={() => onSelect(index)}
      onDoubleClick={() => onFilter(index)}
      onContextMenu={(e) => {
        e.preventDefault();
        onEdit(index);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(index);
        }
      }}
    >
      <span className="pdb-csl__swatch" style={{ background: color.hex }} aria-hidden />
      <span className="pdb-csl__info">
        <span className="pdb-csl__line1">
          <span className="pdb-csl__code">{color.code}</span>
          <span className="pdb-csl__name">{color.nameZh ? `${color.nameZh} · ` : ''}{color.name}</span>
        </span>
        <span className="pdb-csl__line2">
          <span className="pdb-csl__hex">{color.hex}</span>
          <span className="pdb-csl__usage">
            <span>用 <b>{used}</b></span>
            <span className={`pdb-csl__rem ${remaining === 0 ? 'is-zero' : ''}`}>余 {remaining}</span>
          </span>
        </span>
      </span>
      <span className="pdb-csl__actions">
        <button
          type="button"
          className="pdb-csl__act"
          aria-label="编辑颜色"
          title="编辑 / 替换 / 删除"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(index);
          }}
        >
          <PdbIcon name="pencil" size={14} />
        </button>
      </span>
    </div>
  );
});

/* ---------------- 主组件 ---------------- */

export function ColorSwatchList() {
  const palette = usePdbStore((s) => s.palette);
  const beads = usePdbStore((s) => s.beads);
  const placedMask = usePdbStore((s) => s.placedMask);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);
  const activeColorIndex = usePdbStore((s) => s.activeColorIndex);
  const setActiveColorIndex = usePdbStore((s) => s.setActiveColorIndex);
  const filterColorIndex = usePdbStore((s) => s.filterColorIndex);
  const filterMode = usePdbStore((s) => s.filterMode);
  const setFilter = usePdbStore((s) => s.setFilter);
  const addColor = usePdbStore((s) => s.addColor);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('code');
  const [group, setGroup] = useState<GroupKey>('series');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** 缩略模式（用户反馈：默认只显示当前色，其余隐藏，点击展开切换） */
  const [listOpen, setListOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);

  /* 用量统计：遍历一次 beads 计数（索引+1）。依赖 beadsVersion 做缓存失效。
   * 注意：此处刻意在组件内用局部 useMemo 计算，未 import src/store/selectors.ts
   *（selectors 由  并发创建，避免耦合与循环依赖）。TODO：接线后应改为消费 selectors
   * 提供的逐色用量/剩余统计，删除本局部实现。 */
  const usage = useMemo(() => {
    const n = palette.colors.length;
    const used = new Uint32Array(n);
    const placed = new Uint32Array(n);
    for (let i = 0; i < beads.length; i++) {
      const v = beads[i];
      if (v === 0) continue;
      const k = v - 1;
      if (k < n) {
        used[k]++;
        if (placedMask[i] === 1) placed[k]++;
      }
    }
    return { used, placed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beads, placedMask, beadsVersion, palette.colors.length]);

  /* 全量行（含 hue/light 预计算），依赖 palette.colors 与 usage */
  const allRows = useMemo<Row[]>(() => {
    return palette.colors.map((color, index) => {
      const hsl = rgbToHsl(color.rgb);
      return {
        color,
        index,
        used: usage.used[index] ?? 0,
        placed: usage.placed[index] ?? 0,
        hue: hsl[0],
        light: hsl[2],
      };
    });
  }, [palette.colors, usage]);

  /* 搜索过滤 */
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? allRows.filter((r) => {
          const c = r.color;
          return (
            c.code.toLowerCase().includes(q) ||
            c.name.toLowerCase().includes(q) ||
            (c.nameZh ?? '').toLowerCase().includes(q) ||
            c.hex.toLowerCase().includes(q)
          );
        })
      : allRows;
    const sorted = base.slice();
    switch (sort) {
      case 'usage':
        sorted.sort((a, b) => b.used - a.used || a.index - b.index);
        break;
      case 'hue':
        sorted.sort((a, b) => a.hue - b.hue || b.light - a.light);
        break;
      case 'light':
        sorted.sort((a, b) => b.light - a.light || a.hue - b.hue);
        break;
      case 'code':
      default:
        sorted.sort((a, b) => a.color.code.localeCompare(b.color.code, undefined, { numeric: true }));
        break;
    }
    return sorted;
  }, [allRows, query, sort]);

  /* 分组（保持组内已排序）；none = 单组 */
  const groups = useMemo<{ key: string; rows: Row[] }[]>(() => {
    if (group === 'none') return [{ key: '__all__', rows }];
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const key = group === 'series' ? (r.color.series || '未分组') : hueBucket(r);
      let arr = map.get(key);
      if (!arr) {
        arr = [];
        map.set(key, arr);
      }
      arr.push(r);
    }
    return [...map.entries()].map(([key, rs]) => ({ key, rows: rs }));
  }, [rows, group]);

  const totalUsed = useMemo(() => rows.reduce((s, r) => s + r.used, 0), [rows]);

  const onSelect = useCallback((i: number) => setActiveColorIndex(i), [setActiveColorIndex]);
  const onFilter = useCallback(
    (i: number) => setFilter(i, filterColorIndex === i && filterMode !== 'off' ? 'off' : 'only'),
    [setFilter, filterColorIndex, filterMode],
  );
  const onEdit = useCallback((i: number) => {
    setEditorIndex(i);
    setEditorOpen(true);
  }, []);
  const openNew = useCallback(() => {
    setEditorIndex(null);
    setEditorOpen(true);
  }, []);
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  }, []);

  const activeRow = activeColorIndex >= 0 ? palette.colors[activeColorIndex] : null;

  return (
    <div className="pdb-csl">
      {/* 当前色芯片（缩略态）：点击展开完整色板进行切换 */}
      <button
        type="button"
        className={`pdb-csl__current pdb-pressable ${listOpen ? 'is-open' : ''}`}
        aria-expanded={listOpen}
        title={listOpen ? '收起色板' : '展开色板（全部颜色 / 搜索 / 排序）'}
        onClick={() => setListOpen((v) => !v)}
      >
        <span
          className="pdb-csl__current-swatch"
          style={{ background: activeRow?.hex ?? 'transparent' }}
          data-empty={activeRow ? undefined : 'true'}
          aria-hidden
        />
        <span className="pdb-csl__current-code">{activeRow?.code ?? '无色'}</span>
        <span className="pdb-csl__current-name">
          {activeRow ? activeRow.nameZh ?? activeRow.name : '点击展开选色'}
        </span>
        <span className="pdb-csl__current-count">{palette.colors.length} 色</span>
        <span className="pdb-csl__chev" aria-hidden>
          <PdbIcon name={listOpen ? 'chevronUp' : 'chevronDown'} size={14} />
        </span>
      </button>

      {listOpen && (
      <>
      <div className="pdb-csl__tools">
        <label className="pdb-csl__search">
          <PdbIcon name="search" size={14} />
          <input
            type="text"
            value={query}
            placeholder="搜索色号 / 名称 / HEX…"
            aria-label="搜索颜色"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="pdb-csl__act" aria-label="清除搜索" onClick={() => setQuery('')}>
              <PdbIcon name="close" size={13} />
            </button>
          )}
        </label>
        <div className="pdb-csl__segrow">
          <span className="pdb-label">排序</span>
          <Segmented<SortKey>
            ariaLabel="排序方式"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'code', label: '色号', title: '按色号字母/数字顺序排列' },
              { value: 'usage', label: '用量', title: '按本图用量从多到少排列' },
              { value: 'hue', label: '色相', title: '按色相环角度排列（彩虹序）' },
              { value: 'light', label: '明度', title: '按明度从深到浅排列' },
            ]}
          />
        </div>
        <div className="pdb-csl__segrow">
          <span className="pdb-label">分组</span>
          <Segmented<GroupKey>
            ariaLabel="分组方式"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'series', label: '系列' },
              { value: 'hue', label: '色相' },
              { value: 'none', label: '不分组' },
            ]}
          />
        </div>
      </div>

      <div className="pdb-csl__body">
        {rows.length === 0 && <div className="pdb-csl__empty">没有匹配的颜色</div>}
        {groups.map((g) => {
          const isCollapsed =
            group !== 'none' && (collapsed[g.key] ?? !g.rows.some((r) => r.index === activeColorIndex));
          return (
            <div key={g.key}>
              {group !== 'none' && (
                <button
                  type="button"
                  className="pdb-csl__group-head"
                  data-open={!isCollapsed}
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? `展开「${g.key}」（${g.rows.length} 色）` : `折叠「${g.key}」`}
                  onClick={() => toggleGroup(g.key)}
                >
                  <span className="pdb-csl__chev">
                    <PdbIcon name="chevronDown" size={13} />
                  </span>
                  <span>{g.key}</span>
                  <span className="pdb-csl__group-count">{g.rows.length}</span>
                </button>
              )}
              {!isCollapsed &&
                g.rows.map((r) => (
                  <ColorRow
                    key={r.color.id}
                    row={r}
                    isActive={r.index === activeColorIndex}
                    isFiltered={r.index === filterColorIndex && filterMode !== 'off'}
                    onSelect={onSelect}
                    onFilter={onFilter}
                    onEdit={onEdit}
                  />
                ))}
            </div>
          );
        })}
      </div>
      </>
      )}

      <div className="pdb-csl__foot">
        <span className="pdb-hint">
          {rows.length} 色{query ? '（已筛选）' : ''} · 本图共用 {totalUsed} 格
          {activeRow ? ` · 当前 ${activeRow.code}` : ''}
        </span>
        <span className="pdb-cedit__rowbtns">
          <EyedropperButton
            size="sm"
            onPick={(c) => {
              addColor({
                id: `custom-${Date.now().toString(36)}`,
                code: `U${palette.colors.length + 1}`,
                name: 'Picked',
                nameZh: '吸管取色',
                hex: c.hex,
                series: '自定义 Custom',
                builtin: false,
              });
            }}
          />
          <Button size="sm" variant="outline" onClick={openNew} title="新增自定义色：加入「自定义 Custom」系列，可编辑 HEX/色号/名称，不污染内置色板">
            <PdbIcon name="plus" size={14} /> 新增色
          </Button>
        </span>
      </div>

      <ColorEditor open={editorOpen} index={editorIndex} onClose={() => setEditorOpen(false)} />
    </div>
  );
}
