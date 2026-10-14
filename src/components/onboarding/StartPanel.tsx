/**
 * onboarding/StartPanel.tsx —— 「开始 / 帮助」面板。
 *
 * 由 Toolbar 的帮助按钮派发 `pdb:open-start` 打开（与  的 SaveDialog/OpenDialog 同构），
 * 在 AppShell 里全局只挂一份，任何布局下都能用。
 *
 * 面板内容：
 *   1 当前项目信息（名字 / 路径 / 是否有未保存改动）
 *   2 快速开始（导入图片 / 打开项目 / 保存项目 / 新建空白板 / 导出施工图）
 *   3 最近项目（自建列表，空态给友好引导文案与操作入口）
 *   4 快捷键速查（直接消费 hooks/hotkeyMap.buildCheatSheet()，与实现永不同步失效）
 *   5 实验功能（本机当作智能板从左侧工具栏降级到此，不再占主界面）
 *   6 重看新手引导 / 关于与文档
 */
import { useCallback, useEffect, useState } from 'react';
import { usePdbStore } from '@/store';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PdbIcon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { runAppAction, setPlacementMode } from '@/hooks/useHotkeys';
import { buildCheatSheet } from '@/hooks/hotkeyMap';
import { openOpenDialog, openSaveDialog } from '@/components/project/dialogBus';
import {
  getCurrentProjectInfo,
  listRecentProjects,
  newProject,
  openRecentProject,
} from '@/store/persistence';
import type { RecentEntry } from '@/io/recent';
import { getBridge } from '@/io/bridge';
import { EV_OPEN_START, openWelcomeWizard } from './firstRun';
import './onboarding.css';

interface QuickAction {
  icon: IconName;
  label: string;
  desc: string;
  run: () => void;
}

export function StartPanel() {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const pushToast = usePdbStore((s) => s.pushToast);
  const beadsVersion = usePdbStore((s) => s.beadsVersion);

  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ handled?: boolean }>;
      if (ce.detail) ce.detail.handled = true;
      setOpen(true);
    };
    window.addEventListener(EV_OPEN_START, handler);
    return () => window.removeEventListener(EV_OPEN_START, handler);
  }, []);

  const refreshRecent = useCallback(async (): Promise<void> => {
    setLoadingRecent(true);
    try {
      setRecent(await listRecentProjects());
    } catch {
      setRecent([]);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  // 打开面板时刷新一次最近项目；beadsVersion 参与依赖以便「保存后立刻能看到自己」
  useEffect(() => {
    if (!open) return;
    void refreshRecent();
  }, [open, refreshRecent, beadsVersion]);

  const closeAndRun = (fn: () => void): void => {
    setOpen(false);
    fn();
  };

  const actions: QuickAction[] = [
    {
      icon: 'import',
      label: '导入图片',
      desc: '裁剪 → 像素化 → 自动配色，一张图变成图纸',
      run: () => closeAndRun(() => runAppAction('importImage')),
    },
    {
      icon: 'folderOpen',
      label: '打开项目',
      desc: '从 .pdp.json 文件恢复整块板与拼豆进度',
      run: () => closeAndRun(openOpenDialog),
    },
    {
      icon: 'save',
      label: '保存项目',
      desc: '给项目起个名字，存到磁盘或浏览器本地',
      run: () => closeAndRun(openSaveDialog),
    },
    {
      icon: 'plus',
      label: '新建空白板',
      desc: '清空当前图案，从 104×104 空白开始手工设计',
      run: () => closeAndRun(() => newProject()),
    },
    {
      icon: 'export',
      label: '导出施工图',
      desc: '1:1 图纸 / 分块图纸 / 颜色清单等 7 种产物',
      run: () => closeAndRun(() => runAppAction('export')),
    },
    {
      icon: 'bead',
      label: '进入拼豆模式',
      desc: '全屏 1:1 + 暗夜发光 + 防休眠，把板子贴上来',
      run: () => closeAndRun(() => setPlacementMode(true)),
    },
  ];

  const handleOpenRecent = async (entry: RecentEntry): Promise<void> => {
    setOpeningId(entry.id);
    try {
      const outcome = await openRecentProject(entry.id);
      if (outcome.ok) {
        setOpen(false);
        pushToast('success', `已打开项目：${outcome.name}`, 3000);
      } else if (!outcome.cancelled && outcome.error) {
        pushToast('danger', `打开失败：${outcome.error}`, 6000);
      }
    } catch (err) {
      pushToast('danger', `打开异常：${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      setOpeningId(null);
    }
  };

  const info = getCurrentProjectInfo();
  const sheet = buildCheatSheet();
  const browser = getBridge().env === 'browser';

  return (
    <Modal open={open} wide title="开始 · 帮助" onClose={() => setOpen(false)}>
      <div className="pdb-start">
        <section className="pdb-start__sec">
          <p className="pdb-wiz-section__title">
            当前项目
            <span className="pdb-wiz-section__aside">
              {info.dirty ? '有未保存的改动' : '已是最新'} · {browser ? '浏览器模式' : '桌面模式'}
            </span>
          </p>
          <div className="pdb-start__project">
            <PdbIcon name="blocks" size={16} />
            <div>
              <strong>{info.name}</strong>
              <span>{info.path ?? (browser ? '保存在浏览器本地（IndexedDB）' : '尚未选择保存位置')}</span>
            </div>
          </div>
        </section>

        <section className="pdb-start__sec">
          <p className="pdb-wiz-section__title">快速开始</p>
          <div className="pdb-start__grid">
            {actions.map((a) => (
              <button key={a.label} type="button" className="pdb-start__card pdb-pressable pdb-lift" onClick={a.run}>
                <span className="pdb-start__card-icon" aria-hidden>
                  <PdbIcon name={a.icon} size={18} />
                </span>
                <span className="pdb-start__card-body">
                  <strong>{a.label}</strong>
                  <span>{a.desc}</span>
                </span>
                <PdbIcon name="chevronRight" size={14} />
              </button>
            ))}
          </div>
        </section>

        <section className="pdb-start__sec">
          <p className="pdb-wiz-section__title">
            最近项目
            <span className="pdb-wiz-section__aside">
              <Button icon size="sm" variant="ghost" aria-label="刷新最近项目" onClick={() => void refreshRecent()}>
                <PdbIcon name="search" size={13} />
              </Button>
            </span>
          </p>
          {loadingRecent ? (
            <div className="pdb-empty pdb-empty--inline">
              <span className="pdb-empty__spin" aria-hidden />
              正在读取最近项目…
            </div>
          ) : recent.length === 0 ? (
            <div className="pdb-empty pdb-empty--inline">
              <span className="pdb-empty__icon" aria-hidden>
                <PdbIcon name="folderOpen" size={22} />
              </span>
              <strong>还没有最近项目</strong>
              <p>
                保存一次项目后，它就会出现在这里，下次一键接着拼。
                <br />
                {browser
                  ? '浏览器模式存在本机 IndexedDB 里，换浏览器或清缓存会丢，重要图纸建议导出 PNG/CSV。'
                  : '桌面模式记录真实文件路径，重开即可继续。'}
              </p>
              <div className="pdb-empty__actions">
                <Button variant="primary" size="sm" onClick={() => closeAndRun(openSaveDialog)}>
                  <PdbIcon name="save" size={14} />
                  现在保存项目
                </Button>
                <Button variant="outline" size="sm" onClick={() => closeAndRun(() => runAppAction('importImage'))}>
                  <PdbIcon name="import" size={14} />
                  从图片开始
                </Button>
              </div>
            </div>
          ) : (
            <ul className="pdb-start__recent" role="list">
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="pdb-start__recent-item pdb-pressable"
                    disabled={openingId === entry.id}
                    onClick={() => void handleOpenRecent(entry)}
                    aria-label={`打开项目 ${entry.name}`}
                  >
                    <PdbIcon name="blocks" size={15} />
                    <span className="pdb-start__recent-name">{entry.name}</span>
                    <span className="pdb-start__recent-meta">{entry.path || '浏览器存储'}</span>
                    <span className="pdb-start__recent-meta">{formatTime(entry.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pdb-start__sec">
          <p className="pdb-wiz-section__title">
            快捷键速查
            <span className="pdb-wiz-section__aside">完整表见 docs/USAGE.md</span>
          </p>
          <div className="pdb-start__keys">
            {Object.entries(sheet).map(([group, entries]) => (
              <div key={group} className="pdb-start__keygroup">
                <strong>{group}</strong>
                <dl>
                  {entries.map((e) => (
                    <div key={e.action}>
                      <dt>
                        <kbd>{e.combo}</kbd>
                      </dt>
                      <dd>{e.label}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>

        {/* 实验功能区：收纳不占主界面的按需工具。
            「本机当作智能板」曾在此，2026-09-30 起升级回左侧工具栏入口；
            旧的真板子蓝牙探测（SmartBoardDialog）从工具栏挪到这里。 */}
        <section className="pdb-start__sec">
          <p className="pdb-wiz-section__title">
            实验功能
            <span className="pdb-wiz-section__aside">按需使用，不影响正常拼豆</span>
          </p>
          <div className="pdb-start__grid">
            <button
              type="button"
              className="pdb-start__card pdb-pressable pdb-lift"
              onClick={() => closeAndRun(() => window.dispatchEvent(new CustomEvent('pdb:open-virtualboard')))}
            >
              <span className="pdb-start__card-icon" aria-hidden>
                <PdbIcon name="monitor" size={18} />
              </span>
              <span className="pdb-start__card-body">
                <strong>本机当作智能板</strong>
                <span>把电脑伪装成智能拼豆板（本项目是板子），供手机 App 等工具连接联调（仅桌面端；左侧工具栏也有入口）</span>
              </span>
              <PdbIcon name="chevronRight" size={14} />
            </button>
            <button
              type="button"
              className="pdb-start__card pdb-pressable pdb-lift"
              onClick={() => closeAndRun(() => window.dispatchEvent(new CustomEvent('pdb:open-smartboard')))}
            >
              <span className="pdb-start__card-icon" aria-hidden>
                <PdbIcon name="search" size={18} />
              </span>
              <span className="pdb-start__card-body">
                <strong>智能板蓝牙探测（旧）</strong>
                <span>搜索附近真实的智能拼豆板并连接，枚举它的 GATT 服务与特征值（协议联调用，需真板子）</span>
              </span>
              <PdbIcon name="chevronRight" size={14} />
            </button>
          </div>
        </section>

        <section className="pdb-start__sec pdb-start__foot">
          <Button variant="outline" size="sm" onClick={() => closeAndRun(openWelcomeWizard)}>
            <PdbIcon name="bead" size={14} />
            重看新手引导（5 步）
          </Button>
          <p className="pdb-wiz-note">
            <PdbIcon name="info" size={13} />
            更完整的说明在仓库 <code>docs/USAGE.md</code>：启动脚本、核心功能指南、校准五法、
            主题×布局、7 种导出产物、浏览器降级与色板免责声明。
          </p>
        </section>
      </div>
    </Modal>
  );
}

export default StartPanel;

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} 天前`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}
