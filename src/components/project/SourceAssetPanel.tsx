import { useSyncExternalStore } from 'react';
import { usePdbStore } from '@/store';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import {
  getProjectSourceImage,
  setProjectSourceImage,
  subscribeProjectSourceImage,
} from '@/store/persistence';
import { dataUrlByteSize } from '@/io/project';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SourceAssetPanel() {
  const source = useSyncExternalStore(
    subscribeProjectSourceImage,
    getProjectSourceImage,
    getProjectSourceImage,
  );
  const pushToast = usePdbStore((s) => s.pushToast);

  const removeSource = (): void => {
    setProjectSourceImage(null);
    pushToast('info', '已移除源图素材', 1800);
  };

  const openImport = (): void => {
    window.dispatchEvent(new CustomEvent('pdb:open-import'));
  };

  if (!source) {
    return (
      <div className="pdb-source-asset pdb-source-asset--empty">
        <div className="pdb-source-asset__icon" aria-hidden>
          <PdbIcon name="import" size={20} />
        </div>
        <span className="pdb-source-asset__title">暂无源图素材</span>
        <span className="pdb-hint">
          导入图片生成图案后，原图会自动挂到项目中，随项目文件一起保存。
        </span>
        <Button size="sm" variant="soft" onClick={openImport}>
          <PdbIcon name="import" size={13} /> 导入图片
        </Button>
      </div>
    );
  }

  const size = dataUrlByteSize(source.dataUrl);

  return (
    <div className="pdb-source-asset">
      <div className="pdb-source-asset__head">
        <PdbIcon name="import" size={15} />
        <span className="pdb-source-asset__title">源图素材</span>
      </div>
      <div className="pdb-source-asset__preview">
        <img src={source.dataUrl} alt={source.name} />
      </div>
      <div className="pdb-source-asset__meta">
        <span className="pdb-source-asset__name" title={source.name}>
          {source.name}
        </span>
        <span className="pdb-hint">{formatBytes(size)}</span>
      </div>
      <div className="pdb-source-asset__actions">
        <Button size="sm" variant="ghost" onClick={openImport}>
          <PdbIcon name="import" size={13} /> 重新导入
        </Button>
        <Button size="sm" variant="ghost" onClick={removeSource}>
          <PdbIcon name="trash" size={13} /> 移除
        </Button>
      </div>
      <span className="pdb-hint">
        源图超过 2MB 时会自动压缩到上限内，随项目文件一起保存。
      </span>
    </div>
  );
}
