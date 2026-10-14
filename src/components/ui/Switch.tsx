/**
 * ui/Switch —— 开关（网格显隐、编号显隐等布尔板参数）。
 */
export interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** 悬停说明（原生 title） */
  title?: string;
}

export function Switch({ checked, onChange, label, disabled = false, title }: SwitchProps) {
  return (
    <button
      type="button"
      className="pdb-switch"
      role="switch"
      aria-checked={checked}
      data-on={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="pdb-switch__track">
        <span className="pdb-switch__thumb" />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}
