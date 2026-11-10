using System.Buffers.Binary;

namespace L2GrindLens.Net;

/// <summary>Minimalny parser IPv4 + TCP. Zwraca tylko to, czego potrzebuje składanie strumienia.</summary>
public readonly struct TcpSegment
{
    public readonly uint SrcIp, DstIp;
    public readonly ushort SrcPort, DstPort;
    public readonly uint Seq;
    public readonly byte Flags;
    public readonly ReadOnlyMemory<byte> Payload;

    public bool Fin => (Flags & 0x01) != 0;
    public bool Syn => (Flags & 0x02) != 0;
    public bool Rst => (Flags & 0x04) != 0;
    public bool Ack => (Flags & 0x10) != 0;

    private TcpSegment(uint srcIp, uint dstIp, ushort srcPort, ushort dstPort, uint seq, byte flags, ReadOnlyMemory<byte> payload)
    {
        SrcIp = srcIp; DstIp = dstIp; SrcPort = srcPort; DstPort = dstPort; Seq = seq; Flags = flags; Payload = payload;
    }

    public static bool TryParse(ReadOnlyMemory<byte> ip, out TcpSegment seg)
    {
        seg = default;
        var s = ip.Span;
        if (s.Length < 20 || (s[0] >> 4) != 4) return false;
        int ihl = (s[0] & 0x0F) * 4;
        if (ihl < 20 || s.Length < ihl) return false;
        int totalLen = BinaryPrimitives.ReadUInt16BigEndian(s.Slice(2));
        if (totalLen < ihl || totalLen > s.Length) totalLen = s.Length; // tolerancja na przycięte pakiety
        if (s[9] != 6) return false;                                   // tylko TCP
        ushort fragField = BinaryPrimitives.ReadUInt16BigEndian(s.Slice(6));
        if ((fragField & 0x1FFF) != 0 || (fragField & 0x2000) != 0) return false; // fragmenty IP pomijamy

        uint srcIp = BinaryPrimitives.ReadUInt32BigEndian(s.Slice(12));
        uint dstIp = BinaryPrimitives.ReadUInt32BigEndian(s.Slice(16));

        var t = s.Slice(ihl, totalLen - ihl);
        if (t.Length < 20) return false;
        ushort srcPort = BinaryPrimitives.ReadUInt16BigEndian(t);
        ushort dstPort = BinaryPrimitives.ReadUInt16BigEndian(t.Slice(2));
        uint seq = BinaryPrimitives.ReadUInt32BigEndian(t.Slice(4));
        int dataOff = (t[12] >> 4) * 4;
        if (dataOff < 20 || dataOff > t.Length) return false;
        byte flags = t[13];

        var payload = ip.Slice(ihl + dataOff, t.Length - dataOff);
        seg = new TcpSegment(srcIp, dstIp, srcPort, dstPort, seq, flags, payload);
        return true;
    }

    public static string IpToString(uint ip) => $"{ip >> 24}.{(ip >> 16) & 255}.{(ip >> 8) & 255}.{ip & 255}";
}
