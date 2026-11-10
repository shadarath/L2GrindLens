using System.Buffers.Binary;

namespace L2GrindLens.Capture;

/// <summary>
/// Odczyt plików .pcap (Wireshark/tcpdump) i .pcapng (Wireshark, pktmon etl2pcap).
/// Obsługiwane warstwy łącza: Ethernet (1), raw IP (101), NULL/loopback (0), Linux SLL (113), SLL2 (276).
/// </summary>
public sealed class PcapFileCapture : ICaptureSource
{
    private readonly string _path;

    public PcapFileCapture(string path) => _path = path;

    public void Run(Action<RawPacket> onPacket, CancellationToken ct)
    {
        var data = File.ReadAllBytes(_path);
        if (data.Length < 4) throw new InvalidDataException("plik za krótki");

        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(data);
        if (magic == 0x0A0D0D0A) RunPcapng(data, onPacket, ct);
        else RunPcap(data, magic, onPacket, ct);
    }

    // ---------- klasyczny pcap ----------

    private static void RunPcap(byte[] d, uint magic, Action<RawPacket> onPacket, CancellationToken ct)
    {
        bool bigEndian, nanos;
        switch (magic)
        {
            case 0xA1B2C3D4: bigEndian = false; nanos = false; break;
            case 0xA1B23C4D: bigEndian = false; nanos = true; break;
            case 0xD4C3B2A1: bigEndian = true; nanos = false; break;
            case 0x4D3CB2A1: bigEndian = true; nanos = true; break;
            default: throw new InvalidDataException($"nieznany format pliku (magic 0x{magic:X8})");
        }
        uint U32(int off) => bigEndian ? BinaryPrimitives.ReadUInt32BigEndian(d.AsSpan(off)) : BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(off));

        if (d.Length < 24) throw new InvalidDataException("ucięty nagłówek pcap");
        uint linkType = U32(20) & 0x0FFFFFFF;

        int pos = 24;
        while (!ct.IsCancellationRequested && pos + 16 <= d.Length)
        {
            uint tsSec = U32(pos);
            uint tsFrac = U32(pos + 4);
            int inclLen = (int)U32(pos + 8);
            pos += 16;
            if (inclLen < 0 || pos + inclLen > d.Length) break;

            var ts = DateTimeOffset.FromUnixTimeSeconds(tsSec).LocalDateTime
                     .AddTicks(nanos ? tsFrac / 100 : tsFrac * 10L);
            Deliver(linkType, d, pos, inclLen, ts, onPacket);
            pos += inclLen;
        }
    }

    // ---------- pcapng ----------

    private static void RunPcapng(byte[] d, Action<RawPacket> onPacket, CancellationToken ct)
    {
        bool bigEndian = false;
        var interfaces = new List<(uint LinkType, long TicksPerUnitNumerator, long TicksPerUnitDenominator)>();

        uint U32(int off) => bigEndian ? BinaryPrimitives.ReadUInt32BigEndian(d.AsSpan(off)) : BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(off));
        ushort U16(int off) => bigEndian ? BinaryPrimitives.ReadUInt16BigEndian(d.AsSpan(off)) : BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(off));

        int pos = 0;
        while (!ct.IsCancellationRequested && pos + 12 <= d.Length)
        {
            uint type = BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(pos));
            if (type == 0x0A0D0D0A)
            {
                // Section Header Block: kolejność bajtów ustala magic w ciele bloku.
                uint bom = BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(pos + 8));
                bigEndian = bom == 0x4D3C2B1A;
                interfaces.Clear();
            }
            int blockLen = (int)U32(pos + 4);
            if (blockLen < 12 || pos + blockLen > d.Length) break;
            int body = pos + 8;
            int bodyLen = blockLen - 12;

            switch (type)
            {
                case 1: // Interface Description Block
                {
                    uint linkType = U16(body);
                    byte tsresol = 6; // domyślnie mikrosekundy
                    int opt = body + 8;
                    while (opt + 4 <= body + bodyLen)
                    {
                        ushort code = U16(opt), len = U16(opt + 2);
                        if (code == 0) break;
                        if (code == 9 && len >= 1) tsresol = d[opt + 4];
                        opt += 4 + ((len + 3) & ~3);
                    }
                    // ticks (100 ns) = jednostki * 10^7 / rozdzielczość
                    long den = (tsresol & 0x80) == 0 ? Pow10(tsresol & 0x7F) : 1L << (tsresol & 0x7F);
                    interfaces.Add((linkType, 10_000_000L, den));
                    break;
                }
                case 6: // Enhanced Packet Block
                {
                    int ifId = (int)U32(body);
                    ulong tsUnits = ((ulong)U32(body + 4) << 32) | U32(body + 8);
                    int capLen = (int)U32(body + 12);
                    if (ifId >= interfaces.Count || capLen < 0 || body + 20 + capLen > pos + blockLen) break;
                    var (linkType, num, den) = interfaces[ifId];
                    long ticks = (long)(tsUnits / (ulong)den) * num + (long)(tsUnits % (ulong)den) * num / den;
                    var ts = DateTimeOffset.FromUnixTimeSeconds(0).LocalDateTime.AddTicks(ticks);
                    Deliver(linkType, d, body + 20, capLen, ts, onPacket);
                    break;
                }
                case 3: // Simple Packet Block (bez czasu)
                {
                    if (interfaces.Count == 0) break;
                    int origLen = (int)U32(body);
                    int capLen = Math.Min(origLen, bodyLen - 4);
                    Deliver(interfaces[0].LinkType, d, body + 4, capLen, DateTime.Now, onPacket);
                    break;
                }
            }
            pos += blockLen;
        }
    }

    private static long Pow10(int n) { long r = 1; for (int i = 0; i < n; i++) r *= 10; return r; }

    // ---------- wspólne ----------

    private static void Deliver(uint linkType, byte[] d, int off, int len, DateTime ts, Action<RawPacket> onPacket)
    {
        if (!TryStripLinkLayer(linkType, d, off, len, out int ipOffset)) return;
        onPacket(new RawPacket(ts, d, ipOffset, off + len - ipOffset));
    }

    private static bool TryStripLinkLayer(uint linkType, byte[] d, int off, int len, out int ipOffset)
    {
        ipOffset = off;
        bool IsIp4(int at) => at < off + len && (d[at] >> 4) == 4;
        switch (linkType)
        {
            case 1: // Ethernet
            {
                if (len < 14) return false;
                int p = off + 12;
                ushort type = BinaryPrimitives.ReadUInt16BigEndian(d.AsSpan(p));
                while (type == 0x8100 || type == 0x88A8) // VLAN
                {
                    p += 4;
                    if (p + 2 > off + len) return false;
                    type = BinaryPrimitives.ReadUInt16BigEndian(d.AsSpan(p));
                }
                if (type == 0x0800) { ipOffset = p + 2; return true; }
                // pktmon na Wi-Fi deklaruje Ethernet, ale zapisuje natywne ramki 802.11 z nagłówkiem LLC/SNAP.
                return TryStrip80211(d, off, len, out ipOffset);
            }
            case 101: ipOffset = off; return IsIp4(ipOffset);
            case 0: ipOffset = off + 4; return IsIp4(ipOffset);    // NULL/loopback
            case 113: ipOffset = off + 16; return IsIp4(ipOffset); // Linux SLL
            case 276: ipOffset = off + 20; return IsIp4(ipOffset); // Linux SLL2
            default: return false;
        }
    }

    /// <summary>Ramka danych 802.11: nagłówek 24 bajty (+6 przy ToDS i FromDS, +2 przy QoS), potem LLC/SNAP (8 bajtów) i IPv4.</summary>
    private static bool TryStrip80211(byte[] d, int off, int len, out int ipOffset)
    {
        ipOffset = off;
        if (len < 24 + 8) return false;
        byte fc0 = d[off], fc1 = d[off + 1];
        if ((fc0 & 0x0C) != 0x08) return false;           // typ 2 = dane
        // Bit "protected" (fc1 & 0x40) bywa ustawiony mimo odszyfrowanej zawartości, więc go ignorujemy;
        // o poprawności decyduje sygnatura LLC/SNAP poniżej.
        int hdr = 24;
        if ((fc1 & 0x03) == 0x03) hdr += 6;                // ToDS + FromDS: czwarty adres
        if ((fc0 & 0x80) != 0) hdr += 2;                   // podtyp QoS
        int snap = off + hdr;
        if (snap + 8 > off + len) return false;
        if (d[snap] != 0xAA || d[snap + 1] != 0xAA || d[snap + 2] != 0x03) return false;
        ushort type = BinaryPrimitives.ReadUInt16BigEndian(d.AsSpan(snap + 6));
        if (type != 0x0800) return false;
        ipOffset = snap + 8;
        return ipOffset < off + len && (d[ipOffset] >> 4) == 4;
    }

    public void Dispose() { }
}
