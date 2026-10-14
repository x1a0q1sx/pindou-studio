/**
 * ui/Tabs —— 页签（RightPanel 的 颜色/进度/板参数 三页签等）。
 */
import type { ReactNode } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** 悬停说明（原生 title） */
  title?: string;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
}

export function Tabs<T extends string>({ items, active, onChange }: TabsProps<T>) {
  return (
    <div className="pdb-tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          className="pdb-tabs__item"
          data-active={it.id === active}
          aria-selected={it.id === active}
          title={it.title}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
