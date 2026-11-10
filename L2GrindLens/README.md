# L2GrindLens: szkielet pasywnego podsłuchu Lineage 2

Konsolowa aplikacja .NET 8, która przechwytuje ruch między klientem Lineage 2 a serwerem gry,
składa strumień TCP, odszyfrowuje pakiety i wypisuje je z czasem, opcodem i nazwą. Nie dotyka
procesu gry ani jej plików. Działa od C1 do High Five dzięki profilom protokołu w `profiles/*.json`.

## Szybki start

```bash
dotnet build -c Release
```

Test całego potoku na sztucznej sesji (nie wymaga gry ani uprawnień):

```bash
dotnet run -c Release -- --selftest
```

Nasłuch na żywo (konsola uruchomiona jako administrator, bez Npcap):

```bash
dotnet run -c Release -- --iface 192.168.1.10 --port 7777 --out events.jsonl
```

Sniffer musi działać, zanim postać wejdzie do gry. Klucz szyfru jest w pierwszym pakiecie serwera,
więc połączenie przechwycone od środka pozostaje nieczytelne.

Praca na nagraniu (pcap lub pcapng, z Wiresharka albo z pktmon):

```bash
dotnet run -c Release -- --pcap sesja.pcapng --show sys --msgs systemmsg.txt
```

## Nagranie bez instalowania czegokolwiek: pktmon

Jeśli gniazdo raw nie widzi pakietów przychodzących (w wyniku są tylko linie `C>S`), nagraj sesję
wbudowanym w Windows narzędziem pktmon. Wszystko w PowerShellu jako administrator, przed zalogowaniem postaci:

```bash
pktmon filter add L2 -p 7777
```

```bash
pktmon start --capture --comp nics --pkt-size 0 -f E:\Projects\Wlasne\L2GrindLens\sesja.etl
```

Zaloguj się, pograj chwilę, potem:

```bash
pktmon stop
```

```bash
pktmon etl2pcap E:\Projects\Wlasne\L2GrindLens\sesja.etl -o E:\Projects\Wlasne\L2GrindLens\sesja.pcapng
```

```bash
pktmon filter remove
```

`--pkt-size 0` jest ważne: bez tego pktmon ucina pakiety do 128 bajtów. Potem:

```bash
.\L2GrindLens\bin\Release\net8.0\L2GrindLens.exe --pcap sesja.pcapng --out events.jsonl
```

Nasłuch na żywo przy braku pakietów przychodzących wymaga Npcap (darmowy sterownik) i dodania
`SharpPcap` jako kolejnej implementacji `ICaptureSource`.

## Opcje

| Opcja | Znaczenie |
|---|---|
| `--iface <ip>` | adres IPv4 interfejsu, na którym nasłuchujemy (`--list-ifaces` pokazuje dostępne) |
| `--pcap <plik>` | zamiast nasłuchu czytaj plik pcap |
| `--port <p,p>` | porty serwera gry, domyślnie 7777 |
| `--profile <nazwa>` | wymuś profil zamiast wykrywania po ProtocolVersion |
| `--msgs <plik[:kol]>` | słownik komunikatów: `id<TAB>...<TAB>tekst`, kolumna tekstu domyślnie 1 |
| `--out <plik.jsonl>` | każde zdarzenie jako jedna linia JSON, wejście dla wykresów |
| `--show all\|sys` | konsola: wszystkie pakiety albo tylko zdekodowane |
| `--hex <n>` | dopisz pierwsze n bajtów ciała pakietu |
| `--quiet` | bez wyjścia na konsolę |

## Jak to działa

1. `Capture/` dostarcza surowe pakiety IPv4: `RawSocketCapture` (gniazdo raw SIO_RCVALL, wbudowane w Windows,
   wymaga administratora, nie widzi loopback) albo `PcapFileCapture` (offline). Npcap/SharpPcap da się dodać
   jako trzecią implementację `ICaptureSource`.
2. `Net/TcpSessionTracker` rozpoznaje połączenia po porcie serwera, a `TcpStream` porządkuje segmenty,
   odrzuca retransmisje i wypełnia luki, gdy segment przyjdzie za wcześnie.
3. `L2/L2Framer` tnie strumień na pakiety gry (2 bajty długości + ciało).
4. `L2/L2Session` prowadzi stan połączenia: pierwszy pakiet klienta (ProtocolVersion) wybiera profil,
   pierwszy pakiet serwera (KeyPacket) daje klucz, pierwszy zaszyfrowany pakiet klienta (AuthLogin z loginem
   w UTF-16) służy do weryfikacji klucza. Sprawdzane są warianty: klucz 8 bajtów (C1-C3) i 16 bajtów
   (C4+), offset klucza 1 lub 2. Jeśli żaden wariant nie daje czytelnego loginu, serwer najpewniej używa
   własnego szyfrowania (SmartGuard i podobne) i dalsza praca nad tym serwerem nie ma sensu.
5. `L2/GameCrypt` to szyfr XOR z kluczem ewoluującym o długość każdego pakietu, osobno dla każdego kierunku.
6. `L2/SystemMessageDecoder` czyta id komunikatu i parametry wg tabeli typów z profilu. Z `--msgs` podstawia
   parametry do szablonu tekstu.
7. `L2/EventSink` wypisuje zdarzenia i zapisuje JSONL.

## Profile

Każdy plik w `profiles/` opisuje jedną grupę chronik: opcode ProtocolVersion i zakres numerów wersji,
budowę pakietu z kluczem, opcode SystemMessage, typy jego parametrów oraz nazwy opcodów. Nazwy opcodów
są zebrane ze źródeł L2J i wymagają weryfikacji z emulatorem, na którym stoi konkretny serwer.
Nieznany opcode nie przeszkadza w pracy, jest tylko wypisywany jako liczba.

Dodanie chroniki: skopiuj najbliższy profil, popraw zakres wersji i opcody. Kod nie wymaga zmian.

## Słownik komunikatów

Zdekoduj `system/systemmsg-e.dat` z własnego klienta narzędziem typu L2 Client Dat Editor (na kopii pliku,
nie na oryginale) i zapisz jako tekst rozdzielany tabulatorami. Jeśli tekst jest w innej kolumnie niż
pierwsza po id, podaj ją: `--msgs systemmsg.txt:2`.

## Co dalej

- Uruchom `--selftest`, potem nasłuch na żywo podczas logowania na serwer C1. Jeśli zobaczysz
  "klucz zweryfikowany", deszyfrowanie działa i można dekodować kolejne pakiety.
- Dopisz dekodery DropItem, GetItem i StatusUpdate na wzór `SystemMessageDecoder`.
- Zdarzenia z `--out` wczytuj do SQLite lub bezpośrednio do wykresów.

## Wariant OCR bez instalacji: ocr/L2GrindLens-OCR.html

Dla serwerów z własnym szyfrowaniem protokołu, gdzie sniffer nie odszyfruje ruchu, jest strona
`ocr/L2GrindLens-OCR.html`. Otwórz ją dwuklikiem w Chrome lub Edge (wymagane połączenie z internetem,
bo silnik OCR Tesseract.js dociąga się z CDN; za pierwszym razem kilkanaście MB, potem z pamięci podręcznej).

1. Gra w oknie lub borderless, czat systemowy w osobnym oknie, czcionka czatu powiększona.
2. "Wybierz okno gry", wskaż okno klienta.
3. Zaznacz myszą obszar czatu systemowego na podglądzie.
4. "Start". Nowe linie pojawiają się w dzienniku z czasem, typem i liczbami. "Pobierz JSONL" zapisuje je w tym
   samym formacie zdarzeń, co sniffer.

Gdy jakaś linia rozpozna się źle, kliknij "Zapisz próbkę do analizy". Za pierwszym razem wskaż folder
`ocr\samples` w projekcie, potem każde kliknięcie zapisuje tam trzy pliki z ostatniej klatki: `-source.png`
(wycinek kolorowy), `-ocr.png` (obraz po obróbce, czyli to, co widział silnik) i `.txt` (surowy wynik OCR,
linie po czyszczeniu, zdarzenia i ustawienia). Te pliki wystarczą do znalezienia przyczyny bez dostępu do gry.

Rozpoznane linie są najpierw dopasowywane do szablonów z `ocr/systemmsg.js` (wczytywanego tagiem script,
więc działa z pliku na dysku). Każde zdarzenie dostaje numer komunikatu `id` i pola wycięte z placeholderów;
typ zdarzenia (dmg_dealt, dmg_received, exp, item, crit, miss, block, skill, cooldown...) nadaje tabela
`MSG_TYPES` w pliku HTML, a komunikaty spoza niej dostają typ `msg`. Pole "imię postaci" odróżnia Twoje
obrażenia od cudzych w komunikatach z imieniem ("$c1 has inflicted..."): cudze dostają typ `dmg_other`.
Wzorce z sekcji "Wzorce zapasowe" działają tylko dla linii, które nie pasują do żadnego szablonu.

"Test na próbce" sprawdza cały potok na sztucznym czacie bez gry. "Rozpoznaj raz" ze zrzutem ekranu pozwala
dobrać próg i powiększenie pod konkretną czcionkę. Wzorce komunikatów edytuje się w sekcji "Wzorce",
szablony tekstów bierzesz ze zdekodowanego systemmsg.

Wydajność: OCR w WebAssembly zajmuje od kilkuset do ponad tysiąca ms na klatkę zależnie od wielkości
obszaru, więc realne tempo to 1 do 3 klatek na sekundę. Klatki bez zmian w obrazie są pomijane bez OCR.

## Baza komunikatów: ocr/data

`ocr/data/systemmsg.tsv` to 3236 komunikatów systemowych (id, szablon z $s1/$c1) wyciągniętych skryptem
`extract_systemmsg.py` z pliku `SystemMessageId.java` emulatora L2J Mobius (High Five). Ten sam zbiór jest w
`ocr/systemmsg.js` jako obiekt `window.L2_SYSTEMMSG` do użycia na stronie OCR. Plik TSV pasuje też do `--msgs`
sniffera. Brzmienie części komunikatów na konkretnym serwerze może się różnić od stocku (np. "has inflicted"
zamiast "has done ... points of damage"); dokładne teksty ma `systemmsg-e.dat` w kliencie.

Gdy pliki klienta są zaszyfrowane własnym kluczem serwera (tak jest na Reborn), teksty zbiera się z okna
"System Msg" w grze: wpisz słowo w Find, przechwyć listę stroną OCR ("Rozpoznaj raz" + "Zapisz próbkę"),
a potem uruchom `ocr/data/extract_samples.py`. Skrypt wyciąga pary id + tekst ze wszystkich próbek, poprawia
pomyłki OCR w placeholderach, zapisuje `systemmsg_reborn.tsv` (ze statusem: taki sam / inny / nowy względem
L2J) i przebudowuje `ocr/systemmsg.js` jako bazę L2J nadpisaną wpisami z serwera. Próbki w `ocr/samples`
warto zostawić, bo kolejne uruchomienia scalają wszystko od nowa.

## Jeden plik exe

```bash
dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```
