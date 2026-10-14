using System;
using System.Threading;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Foundation;
using Windows.Storage.Streams;
class W {
  static T Wait<T>(IAsyncOperation<T> op) {
    using (var mre = new ManualResetEventSlim(false)) {
      T r = default(T); Exception err = null;
      op.Completed = (o, s) => { try { if (s == AsyncStatus.Error) err = o.ErrorCode; else r = o.GetResults(); } catch (Exception ex) { err = ex; } mre.Set(); };
      mre.Wait(5000); if (err != null) throw err; return r;
    }
  }
  static byte[] Read(IBuffer b) { var arr = new byte[b.Length]; using (var r = DataReader.FromBuffer(b)) { Wait(r.LoadAsync((uint)b.Length)); r.ReadBytes(arr); } return arr; }
  static void Main() {
    var w = new BluetoothLEAdvertisementWatcher();
    w.ScanningMode = BluetoothLEScanningMode.Active;
    w.Received += (s, e) => {
      Console.WriteLine("ADV addr=" + e.BluetoothAddress.ToString("x12") + " type=" + e.BluetoothAddressType + " rssi=" + e.RawSignalStrengthInDBm);
      foreach (var d in e.Advertisement.DataSections)
        Console.WriteLine("  sect 0x" + d.DataType.ToString("x2") + " len=" + d.Data.Length + " ascii=" + System.Text.Encoding.ASCII.GetString(Read(d.Data)));
      foreach (var m in e.Advertisement.ManufacturerData)
        Console.WriteLine("  manuf 0x" + m.CompanyId.ToString("x4") + " ascii=" + System.Text.Encoding.ASCII.GetString(Read(m.Data)));
    };
    w.Start();
    Thread.Sleep(9000);
    w.Stop();
  }
}
