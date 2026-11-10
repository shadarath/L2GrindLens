using System.Text.RegularExpressions;

namespace L2GrindLens.L2;

/// <summary>
/// Słownik komunikatów systemowych (id -> szablon) ze zdekodowanego systemmsg-e.dat.
/// Format pliku: linie rozdzielane tabulatorami, kolumna 0 = id, kolumna textCol = tekst z placeholderami $s1, $c1...
/// </summary>
public sealed class MessageTable
{
    private static readonly Regex Placeholder = new(@"\$[a-z](\d)", RegexOptions.Compiled);
    private readonly Dictionary<int, string> _texts = new();

    public int Count => _texts.Count;

    public static MessageTable Load(string path, int textCol = 1)
    {
        var t = new MessageTable();
        foreach (var line in File.ReadLines(path))
        {
            if (line.Length == 0 || line[0] == '#') continue;
            var cols = line.Split('\t');
            if (cols.Length <= textCol) continue;
            if (!int.TryParse(cols[0].Trim(), out int id)) continue;
            t._texts[id] = cols[textCol].Trim().Trim('"');
        }
        return t;
    }

    public string? Format(int id, IReadOnlyList<string> parameters)
    {
        if (!_texts.TryGetValue(id, out var template)) return null;
        return Placeholder.Replace(template, m =>
        {
            int n = m.Groups[1].Value[0] - '0';
            return n >= 1 && n <= parameters.Count ? parameters[n - 1] : m.Value;
        });
    }
}
