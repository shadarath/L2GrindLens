using System.Buffers.Binary;

namespace L2GrindLens.L2;

/// <summary>
/// Szyfr XOR serwera gry. Każdy bajt: b[i] ^ key[i mod len] ^ poprzedni_bajt_szyfrogramu.
/// Po każdym pakiecie 4 bajty klucza (od UpdateIndex) rosną o długość ciała pakietu.
/// C1-C3: klucz 8 bajtów, UpdateIndex 0.  C4+: klucz 16 bajtów (8 z serwera + 8 stałych), UpdateIndex 8.
/// Każdy kierunek ma własną kopię klucza, bo ewoluują niezależnie.
/// </summary>
public sealed class GameCrypt
{
    public static readonly byte[] DefaultStaticKey = { 0xC8, 0x27, 0x93, 0x01, 0xA1, 0x6C, 0x31, 0x97 };

    private readonly byte[] _key;
    private readonly int _mask;
    private readonly int _updateIndex;

    public GameCrypt(byte[] key, int updateIndex)
    {
        if (key.Length == 0 || (key.Length & (key.Length - 1)) != 0)
            throw new ArgumentException("długość klucza musi być potęgą dwójki (8 lub 16)");
        _key = (byte[])key.Clone();
        _mask = key.Length - 1;
        _updateIndex = updateIndex;
    }

    public GameCrypt Clone() => new(_key, _updateIndex);

    public void Decrypt(Span<byte> body)
    {
        int prev = 0;
        for (int i = 0; i < body.Length; i++)
        {
            int cur = body[i];
            body[i] = (byte)(cur ^ _key[i & _mask] ^ prev);
            prev = cur;
        }
        Advance(body.Length);
    }

    public void Encrypt(Span<byte> body)
    {
        int prev = 0;
        for (int i = 0; i < body.Length; i++)
        {
            body[i] = (byte)(body[i] ^ _key[i & _mask] ^ prev);
            prev = body[i];
        }
        Advance(body.Length);
    }

    private void Advance(int size)
    {
        var slot = _key.AsSpan(_updateIndex, 4);
        uint old = BinaryPrimitives.ReadUInt32LittleEndian(slot);
        BinaryPrimitives.WriteUInt32LittleEndian(slot, old + (uint)size);
    }
}
