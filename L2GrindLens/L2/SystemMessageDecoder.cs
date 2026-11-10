using System.Buffers.Binary;
using System.Text;

namespace L2GrindLens.L2;

/// <summary>
/// SystemMessage: [opcode][int id][int count]{[int type][dane zależne od typu]}*
/// Typy parametrów opisuje profil (SystemMessageParamTypes).
/// </summary>
public static class SystemMessageDecoder
{
    public static bool TryDecode(ReadOnlySpan<byte> body, Profile profile, out int id, out List<string> parameters, out string? error)
    {
        id = -1;
        parameters = new List<string>();
        error = null;

        if (body.Length < 9) { error = "za krótki pakiet"; return false; }
        id = BinaryPrimitives.ReadInt32LittleEndian(body.Slice(1));
        int count = BinaryPrimitives.ReadInt32LittleEndian(body.Slice(5));
        if (count < 0 || count > 32) { error = $"podejrzana liczba parametrów {count}"; return false; }

        int pos = 9;
        for (int i = 0; i < count; i++)
        {
            if (pos + 4 > body.Length) { error = "ucięte parametry"; return false; }
            int type = BinaryPrimitives.ReadInt32LittleEndian(body.Slice(pos));
            pos += 4;
            if (!profile.ParamTypes.TryGetValue(type, out var spec))
            {
                error = $"nieznany typ parametru {type} (uzupełnij profil)";
                return false;
            }

            var parts = new List<string>();
            foreach (char f in spec)
            {
                switch (f)
                {
                    case 'D':
                        if (pos + 4 > body.Length) { error = "ucięty int32"; return false; }
                        parts.Add(BinaryPrimitives.ReadInt32LittleEndian(body.Slice(pos)).ToString());
                        pos += 4;
                        break;
                    case 'Q':
                        if (pos + 8 > body.Length) { error = "ucięty int64"; return false; }
                        parts.Add(BinaryPrimitives.ReadInt64LittleEndian(body.Slice(pos)).ToString());
                        pos += 8;
                        break;
                    case 'S':
                    {
                        int end = pos;
                        while (end + 1 < body.Length && !(body[end] == 0 && body[end + 1] == 0)) end += 2;
                        if (end + 1 >= body.Length) { error = "string bez terminatora"; return false; }
                        parts.Add(Encoding.Unicode.GetString(body.Slice(pos, end - pos)));
                        pos = end + 2;
                        break;
                    }
                    default:
                        error = $"nieznane pole '{f}' w opisie typu {type}";
                        return false;
                }
            }
            parameters.Add(parts.Count == 1 ? parts[0] : string.Join("/", parts));
        }
        return true;
    }
}
