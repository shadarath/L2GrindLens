namespace L2GrindLens.Net;

public delegate void BytesHandler(ReadOnlySpan<byte> data);

/// <summary>
/// Składanie jednego kierunku strumienia TCP: porządkuje segmenty po numerach sekwencyjnych,
/// odrzuca retransmisje, buforuje segmenty, które przyszły za wcześnie.
/// </summary>
public sealed class TcpStream
{
    private const int MaxPendingBytes = 4 * 1024 * 1024;

    private readonly BytesHandler _deliver;
    private readonly Action<string> _warn;
    private readonly List<(uint Seq, byte[] Data)> _pending = new();
    private int _pendingBytes;
    private uint _next;
    private bool _initialized;

    /// <summary>Strumień zaczął się od środka (bez SYN): nie znamy początku, klucza nie da się odzyskać.</summary>
    public bool MidStream { get; private set; }

    public TcpStream(BytesHandler deliver, Action<string> warn)
    {
        _deliver = deliver;
        _warn = warn;
    }

    public void OnSegment(uint seq, bool syn, ReadOnlySpan<byte> payload)
    {
        if (syn)
        {
            _next = seq + 1; // SYN zajmuje jeden numer sekwencyjny
            _initialized = true;
            _pending.Clear();
            _pendingBytes = 0;
            return;
        }
        if (!_initialized)
        {
            _next = seq;
            _initialized = true;
            MidStream = true;
        }
        if (payload.Length == 0) return;

        _pending.Add((seq, payload.ToArray()));
        _pendingBytes += payload.Length;
        Drain();

        if (_pendingBytes > MaxPendingBytes)
        {
            // Dziura w strumieniu (utracony pakiet). Przeskakujemy do najwcześniejszego zbuforowanego segmentu.
            uint min = _pending[0].Seq;
            foreach (var p in _pending) if ((int)(p.Seq - min) < 0) min = p.Seq;
            _warn($"luka w strumieniu TCP: pomijam {(int)(min - _next)} bajtów");
            _next = min;
            Drain();
        }
    }

    private void Drain()
    {
        bool progress = true;
        while (progress)
        {
            progress = false;
            for (int i = 0; i < _pending.Count; i++)
            {
                var (seq, data) = _pending[i];
                int diff = (int)(seq - _next);
                if (diff > 0) continue; // jeszcze nie jego kolej

                _pending.RemoveAt(i);
                _pendingBytes -= data.Length;
                int skip = -diff;
                if (skip < data.Length)
                {
                    _deliver(data.AsSpan(skip));
                    _next = seq + (uint)data.Length;
                }
                // skip >= data.Length: czysta retransmisja, odrzucamy
                progress = true;
                break;
            }
        }
    }
}
