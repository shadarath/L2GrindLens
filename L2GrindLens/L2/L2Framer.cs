using System.Buffers.Binary;

namespace L2GrindLens.L2;

/// <summary>
/// Dzieli ciągły strumień bajtów na pakiety Lineage 2: 2 bajty długości (little-endian, liczone z nagłówkiem)
/// i ciało pakietu, którego pierwszy bajt to opcode.
/// </summary>
public sealed class L2Framer
{
    private byte[] _buf = new byte[65536];
    private int _len;

    public void Push(ReadOnlySpan<byte> data, Action<byte[]> onBody, Action<string> warn)
    {
        if (_len + data.Length > _buf.Length) Array.Resize(ref _buf, Math.Max(_buf.Length * 2, _len + data.Length));
        data.CopyTo(_buf.AsSpan(_len));
        _len += data.Length;

        int pos = 0;
        while (_len - pos >= 2)
        {
            int packetLen = BinaryPrimitives.ReadUInt16LittleEndian(_buf.AsSpan(pos));
            if (packetLen < 3)
            {
                warn($"niepoprawna długość pakietu {packetLen}, resetuję bufor ({_len - pos} bajtów)");
                _len = 0;
                return;
            }
            if (_len - pos < packetLen) break;

            var body = new byte[packetLen - 2];
            Buffer.BlockCopy(_buf, pos + 2, body, 0, body.Length);
            pos += packetLen;
            onBody(body);
        }

        if (pos > 0)
        {
            Buffer.BlockCopy(_buf, pos, _buf, 0, _len - pos);
            _len -= pos;
        }
    }
}
