using System.Buffers.Binary;
using System.Text;
using L2GrindLens.Capture;
using L2GrindLens.L2;
using L2GrindLens.Net;

namespace L2GrindLens;

/// <summary>
/// Buduje sztuczną sesję (SYN, ProtocolVersion, KeyPacket, zaszyfrowany AuthLogin, zaszyfrowany SystemMessage
/// rozbity na dwa segmenty TCP dostarczone w złej kolejności plus retransmisja, pakiet rozszerzony 0xFE)
/// i przepuszcza ją przez dokładnie ten sam potok co ruch na żywo. Sprawdza, czy SystemMessage został odszyfrowany.
/// </summary>
internal static class SelfTest
{
    public static bool Run(ProfileSet profiles, bool verbose)
    {
        bool all = true;
        foreach (var p in profiles.All)
        {
            bool ok = RunScenario(profiles, p, verbose);
            Console.WriteLine($"[{(ok ? "OK  " : "FAIL")}] profil {p.Name}");
            all &= ok;
        }
        return all;
    }

    private static bool RunScenario(ProfileSet profiles, Profile p, bool verbose)
    {
        var sink = new EventSink { ConsoleOutput = verbose, Collect = new List<L2Event>() };
        var tracker = new TcpSessionTracker(new[] { 7777 },
            (label, mid) => new L2Session(label, profiles, null, sink, null, mid), sink.Warn);
        var sim = new TcpSim();
        var fed = new List<byte[]>();
        void Feed(byte[] pkt)
        {
            fed.Add(pkt);
            tracker.OnPacket(new RawPacket(DateTime.Now, pkt, 0, pkt.Length));
        }

        if (verbose) Console.WriteLine($"--- selftest {p.Name} ---");

        Feed(sim.ClientSyn());
        Feed(sim.ServerSynAck());

        // 1. ProtocolVersion (jawny)
        var pv = new byte[5];
        pv[0] = (byte)p.ProtocolVersionOpcode;
        BinaryPrimitives.WriteInt32LittleEndian(pv.AsSpan(1), p.ProtocolVersionRange[1]);
        Feed(sim.Client(Frame(pv)));

        // 2. KeyPacket (jawny)
        var key8 = new byte[] { 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88 };
        var kp = new List<byte> { (byte)p.KeyPacketOpcode };
        while (kp.Count < p.KeyOffset) kp.Add(0x01);
        kp.AddRange(key8);
        kp.AddRange(new byte[] { 1, 0, 0, 0, 1, 0, 0, 0, 0 });
        Feed(sim.Server(Frame(kp.ToArray())));

        var fullKey = key8.Concat(p.StaticKey).ToArray();
        var clientEnc = new GameCrypt(fullKey, p.KeyUpdateIndex);
        var serverEnc = new GameCrypt(fullKey, p.KeyUpdateIndex);

        // 3. AuthLogin od klienta (zaszyfrowany) z loginem w UTF-16
        var auth = new List<byte> { 0x08 };
        auth.AddRange(Encoding.Unicode.GetBytes("testuser\0"));
        auth.AddRange(new byte[16]);
        var authBytes = auth.ToArray();
        clientEnc.Encrypt(authBytes);
        Feed(sim.Client(Frame(authBytes)));

        // 4. SystemMessage od serwera: id 35, dwa parametry liczbowe 12345 i 678
        var sm = new List<byte> { (byte)p.SystemMessageOpcode };
        AddInt(sm, 35); AddInt(sm, 2); AddInt(sm, 1); AddInt(sm, 12345); AddInt(sm, 1); AddInt(sm, 678);
        var smBytes = sm.ToArray();
        serverEnc.Encrypt(smBytes);
        var (seg1, seg2) = sim.ServerSplit(Frame(smBytes), 7);
        Feed(seg2);   // druga połowa przychodzi pierwsza
        Feed(seg1);
        Feed(seg1);   // retransmisja, musi zostać odrzucona

        // 5. Pakiet rozszerzony 0xFE z sub-opcode 0x0001
        var ex = new byte[] { 0xFE, 0x01, 0x00, 0xAA, 0xBB };
        serverEnc.Encrypt(ex);
        Feed(sim.Server(Frame(ex)));

        var evs = sink.Collect!;
        bool ok = true;
        ok &= Check(evs.Any(e => e.Name == "ProtocolVersion" && e.Decoded != null && e.Decoded.Contains($"profile={p.Name}")),
            "rozpoznanie profilu po ProtocolVersion");
        ok &= Check(evs.Any(e => e.Note != null && e.Note.StartsWith("klucz zweryfikowany")), "weryfikacja klucza");
        ok &= Check(evs.Count(e => e.Name == "SystemMessage") == 1, "dokładnie jeden SystemMessage (retransmisja odrzucona)");
        ok &= Check(evs.Any(e => e.Name == "SystemMessage" && e.Decoded != null
                                 && e.Decoded.Contains("id=35") && e.Decoded.Contains("12345") && e.Decoded.Contains("678")),
            "odszyfrowanie i dekodowanie SystemMessage");
        ok &= Check(evs.Any(e => e.Dir == "S>C" && e.Opcode == 0xFE && e.ExOpcode == 1), "pakiet rozszerzony 0xFE");

        // Te same pakiety zapisane do pcap i pcapng muszą dać ten sam wynik przez czytnik plików.
        ok &= Check(RunFromFile(profiles, p, fed, pcapng: false), "odczyt pliku pcap");
        ok &= Check(RunFromFile(profiles, p, fed, pcapng: true), "odczyt pliku pcapng");
        return ok;

        bool Check(bool cond, string what)
        {
            if (!cond) Console.WriteLine($"   nie przeszło: {what}");
            return cond;
        }
    }

    private static bool RunFromFile(ProfileSet profiles, Profile p, List<byte[]> packets, bool pcapng)
    {
        string path = Path.Combine(Path.GetTempPath(), $"l2grindlens-selftest.{(pcapng ? "pcapng" : "pcap")}");
        if (pcapng) WritePcapng(path, packets); else WritePcap(path, packets);

        var sink = new EventSink { ConsoleOutput = false, Collect = new List<L2Event>() };
        var tracker = new TcpSessionTracker(new[] { 7777 },
            (label, mid) => new L2Session(label, profiles, null, sink, null, mid), sink.Warn);
        using (var src = new PcapFileCapture(path)) src.Run(tracker.OnPacket, CancellationToken.None);
        File.Delete(path);

        return sink.Collect!.Count(e => e.Name == "SystemMessage" && e.Decoded != null && e.Decoded.Contains("id=35 [12345, 678]")) == 1;
    }

    private static void WritePcap(string path, List<byte[]> packets)
    {
        using var w = new BinaryWriter(File.Create(path));
        w.Write(0xA1B2C3D4u); w.Write((ushort)2); w.Write((ushort)4); w.Write(0); w.Write(0u); w.Write(65535u); w.Write(101u);
        long t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var pkt in packets)
        {
            w.Write((uint)(t / 1000)); w.Write((uint)(t % 1000 * 1000)); w.Write((uint)pkt.Length); w.Write((uint)pkt.Length);
            w.Write(pkt);
            t += 10;
        }
    }

    private static void WritePcapng(string path, List<byte[]> packets)
    {
        using var w = new BinaryWriter(File.Create(path));
        // Section Header Block
        w.Write(0x0A0D0D0Au); w.Write(28u); w.Write(0x1A2B3C4Du); w.Write((ushort)1); w.Write((ushort)0); w.Write(-1L); w.Write(28u);
        // Interface Description Block: raw IP, if_tsresol = 6 (mikrosekundy)
        w.Write(1u); w.Write(32u); w.Write((ushort)101); w.Write((ushort)0); w.Write(65535u);
        w.Write((ushort)9); w.Write((ushort)1); w.Write((byte)6); w.Write(new byte[3]); w.Write(0u); w.Write(32u);
        ulong t = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000;
        foreach (var pkt in packets)
        {
            int padded = (pkt.Length + 3) & ~3;
            uint len = (uint)(32 + padded);
            w.Write(6u); w.Write(len); w.Write(0u); w.Write((uint)(t >> 32)); w.Write((uint)t);
            w.Write((uint)pkt.Length); w.Write((uint)pkt.Length); w.Write(pkt); w.Write(new byte[padded - pkt.Length]); w.Write(len);
            t += 10_000;
        }
    }

    private static void AddInt(List<byte> l, int v)
    {
        var b = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(b, v);
        l.AddRange(b);
    }

    private static byte[] Frame(byte[] body)
    {
        var f = new byte[body.Length + 2];
        BinaryPrimitives.WriteUInt16LittleEndian(f, (ushort)f.Length);
        Buffer.BlockCopy(body, 0, f, 2, body.Length);
        return f;
    }

    /// <summary>Generator pakietów IPv4/TCP z poprawnymi numerami sekwencyjnymi (bez sum kontrolnych).</summary>
    private sealed class TcpSim
    {
        private const uint ClientIp = 0x0A000002, ServerIp = 0x0A000001;
        private const ushort ClientPort = 50000, ServerPort = 7777;
        private uint _cSeq = 1000, _sSeq = 5000;

        public byte[] ClientSyn() { var p = Build(true, _cSeq, 0x02, Array.Empty<byte>()); _cSeq++; return p; }
        public byte[] ServerSynAck() { var p = Build(false, _sSeq, 0x12, Array.Empty<byte>()); _sSeq++; return p; }
        public byte[] Client(byte[] data) { var p = Build(true, _cSeq, 0x18, data); _cSeq += (uint)data.Length; return p; }
        public byte[] Server(byte[] data) { var p = Build(false, _sSeq, 0x18, data); _sSeq += (uint)data.Length; return p; }

        public (byte[] First, byte[] Second) ServerSplit(byte[] data, int at)
        {
            var a = Server(data[..at]);
            var b = Server(data[at..]);
            return (a, b);
        }

        private static byte[] Build(bool toServer, uint seq, byte flags, byte[] payload)
        {
            var p = new byte[40 + payload.Length];
            p[0] = 0x45;
            BinaryPrimitives.WriteUInt16BigEndian(p.AsSpan(2), (ushort)p.Length);
            p[8] = 64;
            p[9] = 6;
            BinaryPrimitives.WriteUInt32BigEndian(p.AsSpan(12), toServer ? ClientIp : ServerIp);
            BinaryPrimitives.WriteUInt32BigEndian(p.AsSpan(16), toServer ? ServerIp : ClientIp);
            BinaryPrimitives.WriteUInt16BigEndian(p.AsSpan(20), toServer ? ClientPort : ServerPort);
            BinaryPrimitives.WriteUInt16BigEndian(p.AsSpan(22), toServer ? ServerPort : ClientPort);
            BinaryPrimitives.WriteUInt32BigEndian(p.AsSpan(24), seq);
            p[32] = 0x50;
            p[33] = flags;
            Buffer.BlockCopy(payload, 0, p, 40, payload.Length);
            return p;
        }
    }
}
