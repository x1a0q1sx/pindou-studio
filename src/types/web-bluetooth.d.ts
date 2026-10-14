/**
 * types/web-bluetooth.d.ts —— Web Bluetooth 最小类型声明。
 *
 * 背景：TS 5.9 的 lib.dom 不含 Web Bluetooth 标准类型（尚未稳定进 DOM lib）。
 * 这里按 spec 的**真实接口名**声明用到的最小形状——将来 TS 官方收录时删除本文件
 * 即可无缝切换；名字对不上的自造 API 一律禁止。
 * 必须包在 declare global 里（模块文件的顶层 interface 是模块作用域，
 * 不会与全局 Navigator 合并）。navigator.bluetooth 为可选：能力探测用 if 判断。
 */

export {};

declare global {
  interface Bluetooth {
    /** 系统蓝牙适配器是否可用（false = 无适配器/被关闭/未授权） */
    getAvailability(): Promise<boolean>;
    /** 弹设备选择（Electron 下由主进程接管转给应用自绘 UI） */
    requestDevice(options: BluetoothDeviceRequestOptions): Promise<BluetoothDevice>;
  }

  interface BluetoothLEScanFilterLike {
    name?: string;
    namePrefix?: string;
    services?: Array<string | number>;
  }

  interface BluetoothDeviceRequestOptions {
    acceptAllDevices?: boolean;
    filters?: BluetoothLEScanFilterLike[];
    /** 允许访问的服务（UUID 名 / 0x180A 短号 / 128bit 字符串）；不声明则特征值读取被拒 */
    optionalServices?: Array<string | number>;
  }

  interface BluetoothRemoteGATTCharacteristicProperties {
    readonly broadcast: boolean;
    readonly read: boolean;
    readonly writeWithoutResponse: boolean;
    readonly write: boolean;
    readonly notify: boolean;
    readonly indicate: boolean;
    readonly authenticatedSignedWrites: boolean;
  }

  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly service: BluetoothRemoteGATTService;
    readonly uuid: string;
    readonly properties: BluetoothRemoteGATTCharacteristicProperties;
    readonly value: DataView | null;
    readValue(): Promise<DataView>;
    writeValue(value: BufferSource): Promise<void>;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  }

  interface BluetoothRemoteGATTService extends EventTarget {
    readonly device: BluetoothDevice;
    readonly uuid: string;
    readonly isPrimary: boolean;
    getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
    getCharacteristics(characteristic?: string | number): Promise<BluetoothRemoteGATTCharacteristic[]>;
  }

  interface BluetoothRemoteGATTServer {
    readonly device: BluetoothDevice;
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
    getPrimaryServices(service?: string | number): Promise<BluetoothRemoteGATTService[]>;
  }

  interface BluetoothDevice extends EventTarget {
    /** 系统级稳定标识（Windows 上是设备路径串，较长） */
    readonly id: string;
    readonly name: string | undefined;
    readonly gatt: BluetoothRemoteGATTServer | null;
  }

  interface Navigator {
    readonly bluetooth?: Bluetooth;
  }
}
