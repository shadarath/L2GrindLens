using System.Buffers.Binary;

namespace L2GrindLens.L2;

/// <summary>
/// Stan jednego połączenia klient-serwer gry:
///  1. pierwszy pakiet klienta (ProtocolVersion, jawny) -> wybór profilu,
///  2. pierwszy pakiet serwera (KeyPacket, jawny) -> kandydaci na klucz,
///  3. pierwszy zaszyfrowany pakiet klienta (AuthLogin z loginem w UTF-16) -> weryfikacja kandydata,
///  4. dalej: deszyfrowanie obu kierunków i emisja zdarzeń.
/// </summary>
public sealed class L2Session
{
    private readonly string _label;
    private readonly ProfileSet _profiles;
    private readonly Profile? _forced;
    private readonly EventSink _sink;
    private readonly MessageTable? _msgs;
    private readonly bool _midStream;

    private readonly L2Framer _clientFramer = new();
    private readonly L2Framer _serverFramer = new();
    private readonly List<(bool FromServer, byte[] Body)> _pending = new();

    private Profile? _profile;
    private GameCrypt? _c2s, _s2c;
    private byte[]? _keyPacket;
    private int _clientCount, _serverCount;
    private bool _cryptReady;
    private bool _midStreamWarned;

    public DateTime Now { get; set; } = DateTime.Now;

    public L2Session(string label, ProfileSet profiles, Profile? forced, EventSink sink, MessageTable? msgs, bool midStream)
    {
        _label = label;
        _profiles = profiles;
        _forced = forced;
        _profile = forced;
        _sink = sink;
        _msgs = msgs;
        _midStream = midStream;
    }

    public void OnClientBytes(ReadOnlySpan<byte> data) => _clientFramer.Push(data, b => OnPacket(false, b), Warn);
    public void OnServerBytes(ReadOnlySpan<byte> data) => _serverFramer.Push(data, b => OnPacket(true, b), Warn);

    public void OnClosed() => _sink.Write(Info("połączenie zamknięte"));

    private void Warn(string m) => _sink.Warn($"[{_label}] {m}");

    private void OnPacket(bool fromServer, byte[] body)
    {
        if (body.Length == 0) return;

        if (_midStream)
        {
            if (!_midStreamWarned)
            {
                _midStreamWarned = true;
                Warn("połączenie przechwycone od środka: brak pakietu z kluczem, nie da się odszyfrować. Zaloguj się ponownie przy włączonym snifferze.");
            }
            Emit(fromServer, body, encrypted: true);
            return;
        }

        if (!fromServer && _clientCount++ == 0) { HandleProtocolVersion(body); return; }
        if (fromServer && _serverCount++ == 0) { HandleKeyPacket(body); return; }

        if (!_cryptReady)
        {
            _pending.Add((fromServer, body));
            if (!fromServer && _keyPacket != null) FinishCryptSetup(body);
            else if (_pending.Count > 32) FinishCryptSetup(null);
            return;
        }

        var crypt = fromServer ? _s2c : _c2s;
        if (crypt == null) { Emit(fromServer, body, encrypted: true); return; }
        crypt.Decrypt(body);
        Emit(fromServer, body);
    }

    private void HandleProtocolVersion(byte[] body)
    {
        int opcode = body[0];
        int version = body.Length >= 5 ? BinaryPrimitives.ReadInt32LittleEndian(body.AsSpan(1)) : -1;

        if (_forced == null)
        {
            _profile = _profiles.Select(opcode, version);
            if (_profile == null)
            {
                _profile = _profiles.All[0];
                Warn($"nie rozpoznano protokołu (opcode 0x{opcode:X2}, wersja {version}); używam profilu {_profile.Name}");
            }
        }

        Emit(false, body, name: "ProtocolVersion", decoded: $"version={version} profile={_profile?.Name}");
    }

    private void HandleKeyPacket(byte[] body)
    {
        _keyPacket = body;
        string? note = null;
        if (_profile != null && body[0] != _profile.KeyPacketOpcode)
            note = $"oczekiwano opcode 0x{_profile.KeyPacketOpcode:X2} wg profilu {_profile.Name}";
        int shown = Math.Min(body.Length - 1, 18);
        Emit(true, body, name: "KeyPacket", decoded: Convert.ToHexString(body, 1, shown), note: note);
    }

    private sealed record Candidate(string Desc, byte[] Key, int UpdateIndex);

    private IEnumerable<Candidate> Candidates(byte[] kp)
    {
        var seen = new HashSet<string>();

        if (_profile != null)
        {
            var c = Build(kp, _profile.KeyOffset, _profile.KeyLength, _profile.StaticKey, _profile.KeyUpdateIndex, $"profil {_profile.Name}");
            if (c != null && seen.Add(Convert.ToHexString(c.Key) + c.UpdateIndex)) yield return c;
        }
        if (_forced != null) yield break;

        foreach (int offset in new[] { 1, 2 })
        foreach (bool sixteen in new[] { true, false })
        {
            var c = Build(kp, offset, 8,
                sixteen ? GameCrypt.DefaultStaticKey : Array.Empty<byte>(),
                sixteen ? 8 : 0,
                $"auto offset={offset} klucz={(sixteen ? 16 : 8)}B");
            if (c != null && seen.Add(Convert.ToHexString(c.Key) + c.UpdateIndex)) yield return c;
        }
    }

    private static Candidate? Build(byte[] kp, int offset, int dynLen, byte[] staticKey, int updateIndex, string desc)
    {
        if (kp.Length < offset + dynLen) return null;
        var key = new byte[dynLen + staticKey.Length];
        Buffer.BlockCopy(kp, offset, key, 0, dynLen);
        Buffer.BlockCopy(staticKey, 0, key, dynLen, staticKey.Length);
        if ((key.Length & (key.Length - 1)) != 0) return null;
        return new Candidate(desc, key, updateIndex);
    }

    /// <summary>Wynik = najdłuższy ciąg drukowalnych znaków ASCII zapisanych jako UTF-16LE (login w AuthLogin).</summary>
    private static int Score(ReadOnlySpan<byte> decrypted)
    {
        int best = 0, run = 0;
        for (int i = 1; i + 1 < decrypted.Length;)
        {
            if (decrypted[i] >= 0x20 && decrypted[i] <= 0x7E && decrypted[i + 1] == 0) { run++; i += 2; }
            else { best = Math.Max(best, run); run = 0; i++; }
        }
        return Math.Max(best, run);
    }

    private void FinishCryptSetup(byte[]? firstClientBody)
    {
        _cryptReady = true;

        if (_keyPacket == null)
        {
            Warn("brak pakietu z kluczem, pakiety zostają zaszyfrowane");
            FlushPending();
            return;
        }

        Candidate? best = null;
        int bestScore = -1;
        foreach (var c in Candidates(_keyPacket))
        {
            int score = 0;
            if (firstClientBody != null)
            {
                var copy = (byte[])firstClientBody.Clone();
                new GameCrypt(c.Key, c.UpdateIndex).Decrypt(copy);
                score = Score(copy);
            }
            if (score > bestScore) { best = c; bestScore = score; }
        }

        if (best == null)
        {
            Warn("nie udało się zbudować klucza z pakietu KeyPacket (za krótki?)");
            FlushPending();
            return;
        }

        if (bestScore < 3)
            Warn($"nie udało się zweryfikować klucza (wynik {bestScore}); używam '{best.Desc}'. Serwer może używać własnego szyfrowania.");
        else
            _sink.Write(Info($"klucz zweryfikowany: {best.Desc}, wynik {bestScore}"));

        _c2s = new GameCrypt(best.Key, best.UpdateIndex);
        _s2c = new GameCrypt(best.Key, best.UpdateIndex);
        FlushPending();
    }

    private void FlushPending()
    {
        foreach (var (fromServer, body) in _pending)
        {
            var crypt = fromServer ? _s2c : _c2s;
            if (crypt == null) { Emit(fromServer, body, encrypted: true); continue; }
            crypt.Decrypt(body);
            Emit(fromServer, body);
        }
        _pending.Clear();
    }

    private L2Event Info(string note) => new()
    {
        Time = Now, Session = _label, Dir = "---", Note = note,
    };

    private void Emit(bool fromServer, byte[] body, string? name = null, string? decoded = null, string? note = null, bool encrypted = false)
    {
        int opcode = body[0];
        int? ex = null;

        if (!encrypted && name == null && _profile != null)
        {
            if (opcode == 0xFE && body.Length >= 3)
            {
                ex = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(1));
                if (fromServer) _profile.ServerExNames.TryGetValue(ex.Value, out name);
            }
            else
            {
                (fromServer ? _profile.ServerNames : _profile.ClientNames).TryGetValue(opcode, out name);
            }
        }

        if (!encrypted && decoded == null && fromServer && _profile != null && opcode == _profile.SystemMessageOpcode)
        {
            if (SystemMessageDecoder.TryDecode(body, _profile, out int id, out var prms, out var error))
            {
                decoded = $"id={id} [{string.Join(", ", prms)}]";
                var text = _msgs?.Format(id, prms);
                if (text != null) decoded += $" \"{text}\"";
            }
            else
            {
                decoded = $"id={id} (błąd dekodowania: {error})";
            }
        }

        _sink.Write(new L2Event
        {
            Time = Now,
            Session = _label,
            Dir = fromServer ? "S>C" : "C>S",
            Length = body.Length,
            Opcode = opcode,
            ExOpcode = ex,
            Name = name,
            Decoded = decoded,
            Note = note,
            Encrypted = encrypted,
            Hex = _sink.HexBytes > 0 ? Convert.ToHexString(body, 0, Math.Min(body.Length, _sink.HexBytes)) : null,
        });
    }
}
