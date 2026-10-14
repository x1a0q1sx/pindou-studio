/**
 * ui/ColorInput —— 原生取色器 + HEX 文本双通道（ColorEditor 的基础件）。
 * HEX 输入宽容：可省略 #，失焦/回车时校验并规范化为大写 #RRGGBB。
 */
import { useEffect, useState } from 'react';

export interface ColorInputProps {
  value: string; // #RRGGBB
  onChange: (hex: string) => void;
  disabled?: boolean;
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalize(raw: string): string | null {
  const t = raw.trim();
  if (!HEX_RE.test(t)) return null;
  return `#${t.replace('#', '').toUpperCase()}`;
}

export function ColorInput({ value, onChange, disabled = false }: ColorInputProps) {
  const [text, setText] = useState(value);

  useEffect(() => setText(value), [value]);

  const commit = (): void => {
    const hex = normalize(text);
    if (hex) {
      onChange(hex);
      setText(hex);
    } else {
      setText(value);
    }
  };

  return (
    <span className="pdb-colorinput">
      <input
        type="color"
        className="pdb-colorinput__native"
        value={HEX_RE.test(text.trim()) ? normalize(text)! : value}
        disabled={disabled}
        onChange={(e) => {
          const hex = e.target.value.toUpperCase();
          setText(hex);
          onChange(hex);
        }}
        aria-label="选择颜色"
      />
      <input
        className="pdb-colorinput__hex"
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        aria-label="HEX 色值"
      />
    </span>
  );
}
