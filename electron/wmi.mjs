/**
 * WMI 物理尺寸查询 —— 用 execFile 调 PowerShell 读显示器面板物理厘米数。
 *
 * 铁律（契约）：外层 3 秒硬上限 + try/catch + 失败一律返回 null，绝不阻塞启动、绝不抛异常。
 * 返回 null 时上层（main.mjs collectDisplays）自动降级为 physicalMm=null，走手动校准。
 *
 * 健壮性说明：`Get-CimInstance -Namespace root\wmi` 在 spawned/非交互 powershell 下偶发
 * 抛 CimException 0x80041010（WBEM_E_INVALID_CLASS，"无效类"，WMI provider 冷态）。
 * 因此：① 每次调用即时构造 args（不复用模块级常量数组，规避已实测到的诡异失败）；
 *       ② CimInstance 无有效数据时自动回退老 cmdlet `Get-WmiObject`（走不同 WMI 访问路径，实测更宽容）；
 *       ③ 外层 setTimeout 3s 硬兜底，两次尝试均在预算内（单次冷启 ~0.8s）。
 */
import { execFile } from 'node:child_process';

/** 面板参数查询命令（单位即厘米）；两种 cmdlet 互为回退 */
const CIM_CMD =
  'Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | Select-Object InstanceName, MaxHorizontalImageSize, MaxVerticalImageSize | ConvertTo-Json';
const WMI_CMD =
  'Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBasicDisplayParams | Select-Object InstanceName, MaxHorizontalImageSize, MaxVerticalImageSize | ConvertTo-Json';

/**
 * 单次 PowerShell 查询（即时构造 args）。
 * @param {string} command -Command 后的脚本串
 * @param {number} timeoutMs execFile 超时
 * @returns {Promise<Array<{instanceName:string,widthCm:number,heightCm:number}>>} 解析出的有效行（可能为空数组）
 */
function runQuery(command, timeoutMs) {
  return new Promise((resolve) => {
    // 即时构造，不复用模块级数组（实测规避 spawned 下的诡异 invalid-class 失败）
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
    try {
      execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const list = Array.isArray(parsed) ? parsed : [parsed]; // ConvertTo-Json 单条记录返回对象而非数组
          const rows = [];
          for (const item of list) {
            const w = Number(item && item.MaxHorizontalImageSize);
            const h = Number(item && item.MaxVerticalImageSize);
            // 虚拟屏（如 Todesk Virtual Display Adapter）常为 0，视为无物理尺寸而剔除
            if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
              rows.push({ instanceName: String((item && item.InstanceName) || ''), widthCm: w, heightCm: h });
            }
          }
          resolve(rows);
        } catch {
          resolve([]);
        }
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * 查询全部显示器的 WMI 面板物理厘米数。
 * @returns {Promise<Array<{instanceName:string,widthCm:number,heightCm:number}> | null>}
 *   有效面板参数数组；失败/超时/无数据 → null（上层降级手动校准）
 */
export function queryDisplaysPhysicalCm() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardCap);
      resolve(value);
    };
    // 外层 3 秒硬上限：无论如何绝不阻塞启动超过 3s
    const hardCap = setTimeout(() => finish(null), 3000);

    void (async () => {
      // 尝试 1：Get-CimInstance（现代 cmdlet）；单次 1.4s 超时，给回退留预算
      let rows = await runQuery(CIM_CMD, 1400);
      // 尝试 2：Get-WmiObject 回退（CimInstance 偶发 invalid-class 时兜底）
      if (rows.length === 0) rows = await runQuery(WMI_CMD, 1400);
      finish(rows.length > 0 ? rows : null);
    })();
  });
}
