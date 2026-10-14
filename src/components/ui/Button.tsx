/**
 * ui/Button —— 主/柔/幽/线/危 五种性格，:active 微缩放 0.97。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'soft' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** 图标按钮（正方形，children 只放图标） */
  icon?: boolean;
  children?: ReactNode;
}

export function Button({ variant = 'ghost', size = 'md', icon = false, className = '', children, ...rest }: ButtonProps) {
  const cls = ['pdb-btn', `pdb-btn--${variant}`, `pdb-btn--${size}`, icon ? 'pdb-btn--icon' : '', 'pdb-pressable', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
