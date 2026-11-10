using L2GrindLens.Capture;
using L2GrindLens.L2;

namespace L2GrindLens.Net;

/// <summary>
/// Rozpoznaje połączenia klient-serwer po porcie serwera i prowadzi dla każdego dwa strumienie TCP,
/// które karmią sesję L2.
/// </summary>
public sealed class TcpSessionTracker
{
    public readonly record struct SessionKey(uint ClientIp, ushort ClientPort, uint ServerIp, ushort ServerPort)
    {
        public override string ToString() =>
            $"{TcpSegment.IpToString(ClientIp)}:{ClientPort}->{TcpSegment.IpToString(ServerIp)}:{ServerPort}";
    }

    private sealed class Entry
    {
        public required TcpStream C2S;
        public required TcpStream S2C;
        public required L2Session L2;
        public bool ClientFin, ServerFin;
    }

    private readonly HashSet<int> _serverPorts;
    private readonly Func<string, bool, L2Session> _factory; // (etykieta, midStream) -> sesja
    private readonly Action<string> _warn;
    private readonly Dictionary<SessionKey, Entry> _sessions = new();

    public TcpSessionTracker(IEnumerable<int> serverPorts, Func<string, bool, L2Session> factory, Action<string> warn)
    {
        _serverPorts = new HashSet<int>(serverPorts);
        _factory = factory;
        _warn = warn;
    }

    public void OnPacket(RawPacket p)
    {
        if (!TcpSegment.TryParse(p.Data.AsMemory(p.Offset, p.Length), out var seg)) return;

        bool toServer = _serverPorts.Contains(seg.DstPort);
        bool fromServer = !toServer && _serverPorts.Contains(seg.SrcPort);
        if (!toServer && !fromServer) return;

        var key = toServer
            ? new SessionKey(seg.SrcIp, seg.SrcPort, seg.DstIp, seg.DstPort)
            : new SessionKey(seg.DstIp, seg.DstPort, seg.SrcIp, seg.SrcPort);

        if (toServer && seg.Syn && !seg.Ack)
        {
            // Nowe połączenie: zawsze zaczynamy od świeżej sesji.
            _sessions.Remove(key);
        }

        if (!_sessions.TryGetValue(key, out var e))
        {
            bool midStream = !seg.Syn;
            e = Create(key, midStream);
            _sessions[key] = e;
        }

        e.L2.Now = p.Timestamp;
        var stream = toServer ? e.C2S : e.S2C;
        stream.OnSegment(seg.Seq, seg.Syn, seg.Payload.Span);

        if (seg.Fin) { if (toServer) e.ClientFin = true; else e.ServerFin = true; }
        if (seg.Rst || (e.ClientFin && e.ServerFin))
        {
            e.L2.OnClosed();
            _sessions.Remove(key);
        }
    }

    private Entry Create(SessionKey key, bool midStream)
    {
        string label = key.ToString();
        var l2 = _factory(label, midStream);
        var warn = (string m) => _warn($"[{label}] {m}");
        return new Entry
        {
            L2 = l2,
            C2S = new TcpStream(l2.OnClientBytes, warn),
            S2C = new TcpStream(l2.OnServerBytes, warn),
        };
    }
}
