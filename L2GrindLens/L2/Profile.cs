using System.Text.Json;
using System.Text.Json.Serialization;

namespace L2GrindLens.L2;

/// <summary>
/// Profil protokołu jednej grupy chronik, wczytywany z profiles/*.json.
/// Dodanie nowej chroniki = nowy plik json, bez zmian w kodzie.
/// </summary>
public sealed class Profile
{
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";

    /// <summary>Opcode pierwszego pakietu klienta (ProtocolVersion): 0x00 do Interlude, 0x0E od Kamael.</summary>
    public int ProtocolVersionOpcode { get; set; }
    /// <summary>Zakres numerów protokołu [min, max] obsługiwany przez profil.</summary>
    public int[] ProtocolVersionRange { get; set; } = { 0, 0 };

    /// <summary>Opcode pierwszego pakietu serwera z kluczem: 0x00 do Interlude, 0x2E od Kamael.</summary>
    public int KeyPacketOpcode { get; set; }
    /// <summary>Pozycja pierwszego bajtu klucza w ciele pakietu (opcode ma pozycję 0).</summary>
    public int KeyOffset { get; set; } = 1;
    /// <summary>Liczba bajtów klucza przesyłanych w pakiecie (8).</summary>
    public int KeyLength { get; set; } = 8;
    /// <summary>Stała część klucza doklejana za dynamiczną (hex). Pusta dla C1-C3.</summary>
    public string StaticKeyHex { get; set; } = "";
    /// <summary>Indeks 4 bajtów klucza, które rosną o długość pakietu: 0 dla C1-C3, 8 dla C4+.</summary>
    public int KeyUpdateIndex { get; set; }

    public int SystemMessageOpcode { get; set; } = -1;
    /// <summary>Typ parametru SystemMessage -> opis pól: D = int32, Q = int64, S = string UTF-16 zakończony zerem.</summary>
    public Dictionary<string, string> SystemMessageParamTypes { get; set; } = new();

    public Dictionary<string, string> ServerOpcodes { get; set; } = new();
    public Dictionary<string, string> ServerExOpcodes { get; set; } = new();
    public Dictionary<string, string> ClientOpcodes { get; set; } = new();

    [JsonIgnore] public Dictionary<int, string> ServerNames { get; private set; } = new();
    [JsonIgnore] public Dictionary<int, string> ServerExNames { get; private set; } = new();
    [JsonIgnore] public Dictionary<int, string> ClientNames { get; private set; } = new();
    [JsonIgnore] public Dictionary<int, string> ParamTypes { get; private set; } = new();
    [JsonIgnore] public byte[] StaticKey { get; private set; } = Array.Empty<byte>();

    public bool Matches(int protocolVersionOpcode, int version) =>
        protocolVersionOpcode == ProtocolVersionOpcode
        && ProtocolVersionRange.Length == 2
        && version >= ProtocolVersionRange[0] && version <= ProtocolVersionRange[1];

    internal void Index()
    {
        ServerNames = ToIntMap(ServerOpcodes);
        ServerExNames = ToIntMap(ServerExOpcodes);
        ClientNames = ToIntMap(ClientOpcodes);
        ParamTypes = ToIntMap(SystemMessageParamTypes);
        StaticKey = string.IsNullOrWhiteSpace(StaticKeyHex) ? Array.Empty<byte>() : Convert.FromHexString(StaticKeyHex);
    }

    private static Dictionary<int, string> ToIntMap(Dictionary<string, string> src)
    {
        var d = new Dictionary<int, string>();
        foreach (var (k, v) in src)
        {
            var key = k.Trim();
            int n = key.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToInt32(key[2..], 16)
                : int.Parse(key);
            d[n] = v;
        }
        return d;
    }
}

public sealed class ProfileSet
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public List<Profile> All { get; } = new();

    public static ProfileSet Load(string dir)
    {
        var set = new ProfileSet();
        if (!Directory.Exists(dir)) throw new DirectoryNotFoundException($"brak katalogu profili: {dir}");
        foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f))
        {
            var p = JsonSerializer.Deserialize<Profile>(File.ReadAllText(file), Options)
                    ?? throw new InvalidDataException($"pusty profil: {file}");
            if (string.IsNullOrWhiteSpace(p.Name)) p.Name = Path.GetFileNameWithoutExtension(file);
            p.Index();
            set.All.Add(p);
        }
        if (set.All.Count == 0) throw new InvalidDataException($"nie znaleziono profili w {dir}");
        return set;
    }

    public Profile? ByName(string name) =>
        All.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Najpierw dopasowanie po opcode i numerze wersji, potem po samym opcode.</summary>
    public Profile? Select(int protocolVersionOpcode, int version) =>
        All.FirstOrDefault(p => p.Matches(protocolVersionOpcode, version))
        ?? All.FirstOrDefault(p => p.ProtocolVersionOpcode == protocolVersionOpcode);
}
