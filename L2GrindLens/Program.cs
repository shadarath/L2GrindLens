using System.Net;
using System.Security.Principal;
using L2GrindLens.Capture;
using L2GrindLens.L2;
using L2GrindLens.Net;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("windows")]

namespace L2GrindLens;

internal static class Program
{
    private const string Usage = """
        L2GrindLens - pasywny podsłuch ruchu Lineage 2 (szkielet)

        Użycie:
          L2GrindLens [opcje]

        Źródło:
          --iface <ip>        adres IPv4 interfejsu do nasłuchu (na żywo, wymaga administratora)
          --pcap <plik>       zamiast nasłuchu czytaj plik .pcap z Wiresharka
          --list-ifaces       wypisz interfejsy i zakończ

        Dekodowanie:
          --port <p[,p...]>   porty serwera gry (domyślnie 7777)
          --profile <nazwa>   wymuś profil (domyślnie auto po ProtocolVersion)
          --msgs <plik[:kol]> słownik komunikatów: id<TAB>...<TAB>tekst (kolumna tekstu domyślnie 1)

        Wyjście:
          --out <plik.jsonl>  zapisuj każde zdarzenie jako JSON (jedna linia = jedno zdarzenie)
          --show all|sys      konsola: wszystkie pakiety albo tylko zdekodowane (domyślnie all)
          --hex <n>           dopisz pierwsze n bajtów ciała pakietu w hex
          --quiet             nic nie wypisuj na konsolę (tylko --out)

        Inne:
          --selftest          przepuść sztuczną sesję przez cały potok dla każdego profilu
          --help
        """;

    private static int Main(string[] args)
    {
        var opts = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--")) { Console.Error.WriteLine($"nieznany argument: {args[i]}"); return 2; }
            string key = args[i][2..];
            string? val = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[++i] : null;
            opts[key] = val;
        }

        if (opts.ContainsKey("help")) { Console.WriteLine(Usage); return 0; }

        if (opts.ContainsKey("list-ifaces"))
        {
            foreach (var (addr, name) in RawSocketCapture.ListLocalIPv4()) Console.WriteLine($"{addr,-16} {name}");
            return 0;
        }

        var profiles = ProfileSet.Load(Path.Combine(AppContext.BaseDirectory, "profiles"));

        if (opts.ContainsKey("selftest"))
            return SelfTest.Run(profiles, verbose: !opts.ContainsKey("quiet")) ? 0 : 1;

        Profile? forced = null;
        if (opts.TryGetValue("profile", out var profName) && profName != null && profName != "auto")
        {
            forced = profiles.ByName(profName);
            if (forced == null)
            {
                Console.Error.WriteLine($"nieznany profil '{profName}'. Dostępne: {string.Join(", ", profiles.All.Select(p => p.Name))}");
                return 2;
            }
        }

        MessageTable? msgs = null;
        if (opts.TryGetValue("msgs", out var msgsSpec) && msgsSpec != null)
        {
            int col = 1;
            string path = msgsSpec;
            int colon = msgsSpec.LastIndexOf(':');
            if (colon > 1 && int.TryParse(msgsSpec[(colon + 1)..], out col)) path = msgsSpec[..colon];
            msgs = MessageTable.Load(path, col);
            Console.Error.WriteLine($"słownik komunikatów: {msgs.Count} wpisów");
        }

        var ports = (opts.GetValueOrDefault("port") ?? "7777").Split(',').Select(int.Parse).ToArray();

        using var sink = new EventSink
        {
            ConsoleOutput = !opts.ContainsKey("quiet"),
            Show = opts.GetValueOrDefault("show") ?? "all",
            HexBytes = int.Parse(opts.GetValueOrDefault("hex") ?? "0"),
        };
        if (opts.TryGetValue("out", out var outPath) && outPath != null)
            sink.Jsonl = new StreamWriter(outPath, append: true) { AutoFlush = true };

        var tracker = new TcpSessionTracker(ports, (label, mid) => new L2Session(label, profiles, forced, sink, msgs, mid), sink.Warn);

        ICaptureSource source;
        if (opts.TryGetValue("pcap", out var pcap) && pcap != null)
        {
            source = new PcapFileCapture(pcap);
        }
        else
        {
            if (OperatingSystem.IsWindows() && !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            {
                Console.Error.WriteLine("Nasłuch na żywo wymaga uruchomienia jako administrator (gniazdo raw SIO_RCVALL).");
                return 3;
            }
            var ifaces = RawSocketCapture.ListLocalIPv4().ToList();
            IPAddress? ip = null;
            if (opts.TryGetValue("iface", out var ifaceStr) && ifaceStr != null) ip = IPAddress.Parse(ifaceStr);
            else if (ifaces.Count == 1) ip = ifaces[0].Address;
            if (ip == null)
            {
                Console.Error.WriteLine("Podaj --iface <ip>. Dostępne interfejsy:");
                foreach (var (addr, name) in ifaces) Console.Error.WriteLine($"  {addr,-16} {name}");
                return 2;
            }
            Console.Error.WriteLine($"nasłuch na {ip}, porty serwera: {string.Join(",", ports)}. Ctrl+C kończy.");
            source = new RawSocketCapture(ip);
        }

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        using (source)
        {
            try { source.Run(tracker.OnPacket, cts.Token); }
            catch (Exception ex) { Console.Error.WriteLine($"błąd źródła: {ex.Message}"); return 1; }
        }

        Console.Error.WriteLine($"koniec, zdarzeń: {sink.Count}");
        return 0;
    }
}
