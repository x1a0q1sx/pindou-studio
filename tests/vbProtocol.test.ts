/**
 * tests/vbProtocol.test.ts —— PC 虚拟板帧解析纯函数用例。
 */
import { describe, expect, it } from 'vitest';
import { hexToBytes, parseDrawFrame, frameSummary } from '@/core/vbProtocol';

describe('hexToBytes', () => {
  it('成对解析；奇数尾截断；非法段跳过', () => {
    expect(hexToBytes('0102ff')).toEqual([1, 2, 255]);
    expect(hexToBytes('0a1')).toEqual([10]);
    expect(hexToBytes('')).toEqual([]);
  });
});

describe('parseDrawFrame', () => {
  it('0x02 帧 → RGB + 点对', () => {
    // [02, R=ff, G=80, B=00, x=1,y=2, x=103,y=103]
    const pts = parseDrawFrame('02ff800001026767');
    expect(pts.length).toBe(2);
    expect(pts[0]).toEqual({ x: 1, y: 2, rgb: '#ff8000' });
    expect(pts[1]).toEqual({ x: 103, y: 103, rgb: '#ff8000' });
  });
  it('非 0x02 / 过短 → 空', () => {
    expect(parseDrawFrame('01')).toEqual([]);
    expect(parseDrawFrame('02ff80')).toEqual([]);
  });
});

describe('frameSummary', () => {
  it('已知命令给中文摘要', () => {
    expect(frameSummary('01')).toBe('清屏');
    expect(frameSummary('03')).toBe('提交显示');
    expect(frameSummary('0464')).toBe('亮度 100');
    expect(frameSummary('02ff800001026767')).toBe('绘制 2 点');
    expect(frameSummary('a100a100bf')).toBe('查询设备信息');
    expect(frameSummary('05')).toBe('按键·上一色');
    expect(frameSummary('06')).toBe('按键·下一色');
    expect(frameSummary('a0a200')).toBe('回执 cmd=0xa2 状态=0');
    expect(frameSummary('a20000b80b024131')).toContain('A1'); // 色号提示含 ASCII 文本
  });
  it('未知命令降级为字节摘要；空帧有兜底', () => {
    expect(frameSummary('ff0102')).toContain('0xff');
    expect(frameSummary('')).toBe('空帧');
  });
});
