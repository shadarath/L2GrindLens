using System.Text.Json;
using System.Text.Json.Serialization;

namespace L2GrindLens.L2;

/// <summary>Jedno zdarzenie = jeden pakiet (lub informacja o sesji). To wejście dla późniejszych wykresów.</summary>
public sealed class L2Event
{
    public DateTime Time { get; set; }
    public string Session { get; set; } = "";
    /// <summary>"S>C" lub "C>S"</summary>
    public string Dir { get; set; } = "";
    public int Length { get; set; }
    public int Opcode { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? ExOpcode { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Name { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Decoded { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Note { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Hex { get; set; }
    /// <summary>true = ciało nie zostało odszyfrowane (brak klucza), opcode jest bez znaczenia.</summary>
    public bool Encrypted { get; set; }
}

public sealed class EventSink : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public bool ConsoleOutput { get; set; } = true;
    /// <summary>"all" = każdy pakiet, "sys" = tylko zdekodowane/istotne (SystemMessage, informacje o sesji).</summary>
    public string Show { get; set; } = "all";
    public int HexBytes { get; set; }
    public StreamWriter? Jsonl { get; set; }
    public List<L2Event>? Collect { get; set; }

    public int Count { get; private set; }

    public void Write(L2Event e)
    {
        Count++;
        Collect?.Add(e);
        Jsonl?.WriteLine(JsonSerializer.Serialize(e, JsonOptions));

        if (!ConsoleOutput) return;
        if (Show == "sys" && e.Decoded == null && e.Note == null) return;

        if (e.Dir == "---")
        {
            Console.WriteLine($"{e.Time:HH:mm:ss.fff} --- [{e.Session}] {e.Note}");
            return;
        }

        string op = e.Encrypted ? "  ??  " : e.ExOpcode is int ex ? $"0xFE:{ex:X4}" : $"0x{e.Opcode:X2}   ";
        string name = e.Name ?? (e.Encrypted ? "(zaszyfrowany)" : "");
        var line = $"{e.Time:HH:mm:ss.fff} {e.Dir} len={e.Length,5} {op} {name,-22} {e.Decoded}";
        if (e.Note != null) line += $"  // {e.Note}";
        if (e.Hex != null) line += $"\n    {e.Hex}";
        Console.WriteLine(line);
    }

    public void Warn(string message)
    {
        if (ConsoleOutput) Console.Error.WriteLine($"! {message}");
    }

    public void Dispose() => Jsonl?.Dispose();
}
