/**
 * ui/NumberField —— 数字输入 + 步进按钮（板参数 cols/rows/majorEvery 等用）。
 */
import { useEffect, useState } from 'react';

export interface NumberFieldProps {
  value: number;
  onValueChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

export function NumberField({ value, onValueChange, min = 0, max = 9999, step = 1, disabled = false }: NumberFieldProps) {
  const [text, setText] = useState(String(value));

  // 外部值变化（撤销/预设/切换）时同步文本
  useEffect(() => setText(String(value)), [value]);

  const clamp = (n: number): number => Math.min(max, Math.max(min, n));

  const commit = (): void => {
    const n = Number(text);
    if (Number.isFinite(n)) {
      const clamped = clamp(n);
      onValueChange(clamped);
      setText(String(clamped));
    } else {
      setText(String(value));
    }
  };

  const bump = (delta: number): void => {
    if (disabled) return;
    const next = clamp(Math.round((value + delta) * 1e6) / 1e6);
    onValueChange(next);
    setText(String(next));
  };

  return (
    <span className="pdb-numfield">
      <button type="button" className="pdb-numfield__step" onClick={() => bump(-step)} disabled={disabled} aria-label="减少">
        −
      </button>
      <input
        className="pdb-numfield__input"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp') bump(step);
          if (e.key === 'ArrowDown') bump(-step);
        }}
        inputMode="numeric"
      />
      <button type="button" className="pdb-numfield__step" onClick={() => bump(step)} disabled={disabled} aria-label="增加">
        +
      </button>
    </span>
  );
}
