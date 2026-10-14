/**
 * palette/EyedropperButton —— 吸管按钮。
 * 支持原生 EyeDropper 时一键取屏幕任意处颜色；不支持时降级弹出手动 HEX 输入，
 * 并提示可用「画布格子取色 / 导入图片取色」（由 useEyedropper.pickFromImageData 承接）。
 * 取到色后通过 onPick 回调交给上层（新增颜色 / 修改当前颜色）。
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ColorInput } from '@/components/ui/ColorInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { PdbIcon } from '@/components/icons';
import { useEyedropper, type PickedColor } from '@/hooks/useEyedropper';
import './palette.css';

export interface EyedropperButtonProps {
  /** 取到颜色后的回调（原生取色 / 手动输入均走这里） */
  onPick: (color: PickedColor) => void;
  size?: 'sm' | 'md';
}

export function EyedropperButton({ onPick, size = 'sm' }: EyedropperButtonProps) {
  const { supported, pick, fromHex, isPicking } = useEyedropper();
  const [open, setOpen] = useState(false);
  const [manualHex, setManualHex] = useState('#FF9BB3');

  const handleNative = async (): Promise<void> => {
    const res = await pick();
    if (res) onPick(res);
  };

  const handleManual = (): void => {
    const res = fromHex(manualHex);
    if (res) {
      onPick(res);
      setOpen(false);
    }
  };

  if (supported) {
    return (
      <Tooltip label="吸管取色（屏幕任意处）" side="bottom">
        <Button
          size={size}
          variant="outline"
          icon
          disabled={isPicking}
          onClick={() => void handleNative()}
          aria-label="吸管取色"
        >
          <PdbIcon name="picker" size={15} />
        </Button>
      </Tooltip>
    );
  }

  // 降级：手动 HEX + 说明（画布/图片取色由调用方通过 pickFromImageData 提供）
  return (
    <span className="pdb-eyedrop">
      <Tooltip label="吸管（当前浏览器不支持原生取色）" side="bottom">
        <Button
          size={size}
          variant="outline"
          icon
          onClick={() => setOpen((v) => !v)}
          aria-label="吸管取色（降级）"
          aria-expanded={open}
        >
          <PdbIcon name="picker" size={15} />
        </Button>
      </Tooltip>
      {open && (
        <span className="pdb-eyedrop__pop" role="dialog" aria-label="手动取色">
          <p>
            当前浏览器不支持原生 EyeDropper。可手动输入 HEX，或改用 Chrome/Edge 以支持
            「取屏幕任意处颜色」（含实物豆照片）。
          </p>
          <ColorInput value={manualHex} onChange={setManualHex} />
          <span className="pdb-cedit__rowbtns">
            <Button size="sm" variant="primary" onClick={handleManual}>
              使用该颜色
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
