namespace L2GrindLens.Capture;

/// <summary>Jeden surowy pakiet IPv4 (bez nagłówka warstwy łącza) wraz z czasem przechwycenia.</summary>
public readonly record struct RawPacket(DateTime Timestamp, byte[] Data, int Offset, int Length);

/// <summary>
/// Źródło pakietów. Implementacje: gniazdo raw (na żywo, bez Npcap), plik pcap (offline).
/// Żeby dodać SharpPcap/Npcap wystarczy kolejna implementacja tego interfejsu.
/// </summary>
public interface ICaptureSource : IDisposable
{
    void Run(Action<RawPacket> onPacket, CancellationToken ct);
}
