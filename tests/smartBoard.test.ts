/**
 * tests/smartBoard.test.ts —— 智能板探测纯逻辑层用例（Vitest）。
 * 覆盖：UUID 输入解析、默认授权服务集、短/长 UUID 归一、已知名映射、报告导出、错误文案。
 */
import { describe, expect, it } from 'vitest';
import {
  parseUuidList,
  defaultOptionalServices,
  shortUuidOf,
  serviceLabel,
  characteristicFlags,
  buildProbeText,
  bleErrorHint,
  type ProbeReport,
} from '@/core/smartBoard';

describe('parseUuidList', () => {
  it('0x 短号 / 裸短号 / 128bit 全混排解析', () => {
    const out = parseUuidList('0x180A, ffe0 0000fff0-0000-1000-8000-00805f9b34fb；乱码xx');
    expect(out).toEqual([0x180a, 0xffe0, '0000fff0-0000-1000-8000-00805f9b34fb']);
  });
  it('128bit 转小写；空串/纯空白返回空', () => {
    expect(parseUuidList('12345678-1234-5678-1234-567890ABCDEF')).toEqual([
      '12345678-1234-5678-1234-567890abcdef',
    ]);
    expect(parseUuidList('   ')).toEqual([]);
  });
});

describe('defaultOptionalServices', () => {
  it('含 FF 全段 256 个 + SIG 基础 3 个；附加项去重合并', () => {
    const base = defaultOptionalServices();
    expect(base).toContain('generic_access');
    expect(base).toContain(0xff00);
    expect(base).toContain(0xffff);
    expect(base.length).toBe(256 + 3);
    const merged = defaultOptionalServices([0x180a, 'generic_access']);
    expect(merged.length).toBe(base.length + 1); // generic_access 撞车；0x180a 是新键
    const withNew = defaultOptionalServices([0x180a]);
    expect(withNew.length).toBe(base.length + 1);
  });
});

describe('shortUuidOf / serviceLabel', () => {
  it('标准蓝牙基 UUID 提取短号，异型 UUID 原样小写', () => {
    expect(shortUuidOf('0000FFE0-0000-1000-8000-00805F9B34FB')).toBe('ffe0');
    expect(shortUuidOf('12345678-1234-5678-1234-567890ABCDEF')).toBe('12345678-1234-5678-1234-567890abcdef');
  });
  it('公知服务给中文名，认不出留空不猜', () => {
    expect(serviceLabel('0000180f-0000-1000-8000-00805f9b34fb')).toBe('Battery');
    expect(serviceLabel('0000ffe0-0000-1000-8000-00805f9b34fb')).toContain('HM-10');
    expect(serviceLabel('00001234-0000-1000-8000-00805f9b34fb')).toBe('');
  });
});

describe('characteristicFlags', () => {
  it('按 R W Wn N I 顺序拼接属性位', () => {
    expect(
      characteristicFlags({ read: true, write: false, writeWithoutResponse: true, notify: true, indicate: false }),
    ).toBe('R Wn N');
    expect(characteristicFlags({})).toBe('');
    expect(characteristicFlags(undefined)).toBe('');
  });
});

describe('buildProbeText', () => {
  it('报告树含设备名、服务短号、特征与属性位、失败标记', () => {
    const report: ProbeReport = {
      deviceName: 'BEAD-LIGHT-88',
      deviceId: 'xx:yy',
      connected: true,
      probedAt: '2026-09-11 10:00:00',
      services: [
        {
          uuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
          label: '蓝牙串口（HM-10 类固件）',
          characteristics: [
            { uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', flags: 'R W' },
            { uuid: '0000ffe2-0000-1000-8000-00805f9b34fb', flags: 'N', error: 'GATT 忙' },
          ],
        },
        { uuid: '0000ae30-0000-1000-8000-00805f9b34fb', label: '', error: '未授权' },
      ],
    };
    const text = buildProbeText(report);
    expect(text).toContain('BEAD-LIGHT-88');
    expect(text).toContain('ffe0');
    expect(text).toContain('[R W]');
    expect(text).toContain('GATT 忙');
    expect(text).toContain('未授权');
    expect(text).toContain('服务数：2');
  });
});

describe('bleErrorHint', () => {
  it('常见 DOMException 名 → 针对性中文指引', () => {
    expect(bleErrorHint(new DOMException('x', 'NotFoundError'))).toContain('没有选中设备');
    expect(bleErrorHint(new DOMException('x', 'NetworkError'))).toContain('GATT 连接失败');
    expect(bleErrorHint(new DOMException('x', 'InvalidStateError'))).toContain('蓝牙适配器');
  });
});
