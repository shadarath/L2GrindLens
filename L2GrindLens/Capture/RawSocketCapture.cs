using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.Versioning;

namespace L2GrindLens.Capture;

/// <summary>
/// Przechwytywanie na żywo przez gniazdo raw w trybie SIO_RCVALL (wbudowane w Windows).
/// Nie wymaga Npcap ani żadnego sterownika, ale wymaga uruchomienia jako administrator.
/// Widzi pakiety przychodzące i wychodzące na wskazanym interfejsie. Nie widzi ruchu loopback
/// (serwer na 127.0.0.1) - do tego potrzebny jest Npcap.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RawSocketCapture : ICaptureSource
{
    private readonly IPAddress _local;
    private Socket? _socket;

    public RawSocketCapture(IPAddress local) => _local = local;

    public static IEnumerable<(IPAddress Address, string Name)> ListLocalIPv4()
    {
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up) continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                    yield return (ua.Address, ni.Name);
        }
    }

    public void Run(Action<RawPacket> onPacket, CancellationToken ct)
    {
        _socket = new Socket(AddressFamily.InterNetwork, SocketType.Raw, ProtocolType.IP);
        _socket.Bind(new IPEndPoint(_local, 0));
        _socket.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.HeaderIncluded, true);
        // RCVALL_ON = 1
        _socket.IOControl(IOControlCode.ReceiveAll, BitConverter.GetBytes(1), null);
        _socket.ReceiveTimeout = 500;

        var buf = new byte[65535];
        while (!ct.IsCancellationRequested)
        {
            int n;
            try { n = _socket.Receive(buf); }
            catch (SocketException ex) when (ex.SocketErrorCode == SocketError.TimedOut) { continue; }
            catch (ObjectDisposedException) { break; }
            if (n <= 0) continue;

            var copy = new byte[n];
            Buffer.BlockCopy(buf, 0, copy, 0, n);
            onPacket(new RawPacket(DateTime.Now, copy, 0, n));
        }
    }

    public void Dispose() => _socket?.Dispose();
}
