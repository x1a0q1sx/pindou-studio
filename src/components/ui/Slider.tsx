/**
 * ui/Slider —— 滑杆 + 实时数值。 标尺校准（pitch 2.400–3.000 步进 0.001）、 颜色数等全靠它。
 */
import type { InputHTMLAttributes } from 'react';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: number;
  onValueChange: (v: number) => void;
  /** 数值格式化（默认原样显示） */
  format?: (v: number) => string;
}

export function Slider({ value, onValueChange, format, className = '', ...rest }: SliderProps) {
  return (
    <label className={`pdb-slider ${className}`}>
      <input
        type="range"
        className="pdb-slider__input"
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
        {...rest}
      />
      <span className="pdb-slider__value">{format ? format(value) : value}</span>
    </label>
  );
}
