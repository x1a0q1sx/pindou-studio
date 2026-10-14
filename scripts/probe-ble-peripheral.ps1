# scripts/probe-ble-peripheral.ps1 —— 本机蓝牙栈 BLE 角色能力实测（只读查询，零对外副作用）
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Bluetooth.BluetoothAdapter,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]

$asTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($winRtAsync, $resultType) {
  $generic = $asTaskMethod.MakeGenericMethod($resultType)
  $task = $generic.Invoke($winRtAsync, @($winRtAsync))
  [void]$task.Wait(5000)
  return $task.Result
}

$adapter = Await ([Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync()) ([Windows.Devices.Bluetooth.BluetoothAdapter])
if ($adapter) {
  Write-Output ("CONTROLLER_MODE: " + $adapter.ControllerMode)
  Write-Output ("IS_PERIPHERAL_ROLE_SUPPORTED: " + $adapter.IsPeripheralRoleSupported)
  Write-Output ("IS_CENTRAL_ROLE_SUPPORTED: " + $adapter.IsCentralRoleSupported)
  Write-Output ("IS_LOW_ENERGY_SUPPORTED: " + $adapter.IsLowEnergySupported)
} else {
  Write-Output "ADAPTER: none"
}

$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider,Windows.Devices.Bluetooth.GenericAttributeProfile,ContentType=WindowsRuntime]
try {
  $svc = [Guid]'0000ffe0-0000-1000-8000-00805f9b34fb'
  $res = Await ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider]::CreateAsync($svc)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderResult])
  Write-Output ("GATT_PROVIDER_CREATE: " + $res.Error)
} catch {
  Write-Output ("GATT_PROVIDER_CREATE_EX: " + $_.Exception.Message)
}
