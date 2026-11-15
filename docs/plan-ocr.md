# Plan: stabilizacja i wzmocnienie potoku log z gry → zdarzenia

Stan: plan do akceptacji, nic z poniższego nie jest jeszcze wdrożone.

## 1. Diagnoza

Dzisiejszy potok: klatka → binaryzacja progiem globalnym → Tesseract na całym wycinku → podział na linie po
tekście → porównanie tekstu linii z poprzednią klatką → szablon przez wyrażenie regularne → pola jako wolny
tekst. Każdy z tych kroków przepuszcza błędy dalej i żaden nie korzysta z tego, co wiemy na pewno.

Dwa objawy, które zgłaszasz, mają wspólne źródło: **tożsamość linii jest oparta na tekście z OCR**, a ten tekst
jest niestabilny, gdy pod czatem zmienia się tło.

- Te same przedmioty jako kilka pozycji: nazwa przedmiotu to wolny tekst z OCR ("Leather Stocklng",
  "Leather Stocking"). Nic nie sprowadza jej do jednej postaci.
- Wielokrotne naliczanie XP i dropu: linia odczytana z literówką nie pasuje do poprzedniej klatki, więc uchodzi
  za nową. Potwierdzenie w następnej klatce nie pomaga, gdy szum jest stały (to samo tło przez kilka klatek).
  Obecne dopasowanie dopuszcza też "nowe" linie w środku okna, choć czat dopisuje wyłącznie na dole.
- Próg globalny: przy jasnym tle część tła przechodzi jako "tekst", przy ciemnym tekście część liter znika.

Czego nie wykorzystujemy, a mamy: pełną listę komunikatów (3294 szablony), pełną listę przedmiotów (1535),
potworów (1477) i umiejętności (420), kolory komunikatów w czacie (XP żółty, dropy zielone, obrażenia
białe), stałą czcionkę gry oraz fakt, że czat rośnie tylko od dołu.

## 2. Zasady nowego potoku

1. **Tożsamość linii po obrazie, nie po tekście.** Każda linia czatu dostaje odcisk z jej bitmapy. Ta sama
   linia w kolejnych klatkach ma ten sam odcisk niezależnie od tego, co odczyta OCR.
2. **Nowe wpisy to wyłącznie sufiks.** Czat dopisuje na dole i przewija w górę. Jeśli po dopasowaniu odcisków
   "nowa" linia wychodzi w środku okna, to szum, nie zdarzenie.
3. **Rozpoznawanie przez dopasowanie do słownika na każdym poziomie.** Linia jest dopasowywana do
   najbliższego szablonu z tolerancją na konfuzje OCR, a każde pole tekstowe do najbliższej nazwy z bazy gry.
   Wynik to numery (komunikat, przedmiot, potwór, umiejętność), a tekst z OCR zostaje tylko jako `raw`.
4. **Nie zgadujemy.** Gdy dopasowanie nie przekracza progu, zdarzenie dostaje typ `unknown` z surowym
   tekstem i trafia do osobnej listy do przejrzenia, zamiast psuć statystyki.
5. **Mierzymy.** Zmiany ocenia zestaw próbek z oczekiwanymi wynikami, nie wrażenie z jednej sesji.

## 3. Etapy

### E1. Linie jako obiekty z odciskiem obrazu i reguła sufiksu

Cel: koniec wielokrotnego naliczania.

- Segmentacja wycinka na linie po profilu poziomym (rzędy z atramentem po binaryzacji). Każda linia ma
  prostokąt, bitmapę i odcisk: przeskalowana do stałej szerokości binarna bitmapa, porównywana odległością
  Hamminga. Dwie linie są "te same", gdy odległość jest poniżej progu, bez udziału tekstu.
- Dopasowanie klatek na sekwencjach odcisków (ten sam algorytm nałożenia końca poprzedniej na początek
  bieżącej), z tolerancją na pojedyncze zaszumione linie.
- Nowe linie = wyłącznie sufiks bieżącej klatki po nałożeniu. Niedopasowania w środku są ignorowane.
- Bramka stabilności: OCR dopiero, gdy dwie kolejne klatki mają ten sam zestaw odcisków linii (koniec
  animacji przewijania, brak klatki "w pół renderowania").
- OCR per linia (tryb pojedynczej linii), nie całym blokiem: znikają sklejenia linii i błędne podziały,
  a wynik OCR jest przypięty do konkretnej linii z jej odciskiem i kolorem.
- Zawinięte komunikaty: kontynuacja ma wcięcie i brak kropki na końcu poprzedniej; sklejanie zostaje, ale
  na poziomie obiektów linii, z odciskiem łączonym.

Wpływ: wysoki. Rozwiązuje duplikaty u źródła, niezależnie od jakości OCR.

**Stan (2026-11-14): wdrożone** w `js/image.js` i `js/ocr.js`, z różnicami wobec opisu:

- Odcisk linii to maska tekstu w skali 1:1 (bez przeskalowania); odległość = 1 - IoU pikseli tekstu, najlepsza
  z przesunięć ±2 px w pionie i ±1 w poziomie. Próg 0.25 z analizy próbek (`tools/ocr_fingerprint.py`:
  ta sama linia pod innym tłem max 0.26, inne linie min 0.30).
- Maska tekstu już jest maską barw (część E2): piksel jest tekstem, gdy ma barwę tekstu czatu w HSV i ma
  ciemny piksel obwódki w promieniu 2 px. Do obrazu dla OCR dochodzi luźniejsza maska (`soft`, niższy próg
  jasności i nasycenia) w promieniu 2 px od maski, bo kropki nad i oraz ogonki g/p/q/y są przyciemnione
  przez wygładzanie; bez niej "inflicted" czytało się "mfiicted", a "damage" jako "damaae".
- Bramka stabilności: nowa linia trafia do OCR dopiero, gdy jest nadal widoczna w następnej klatce.
- Zawinięte komunikaty są sklejane po tekście (ogon bez kropki czeka na kontynuację), nie po odcisku.
- Obraz dla silnika przekazywany jako data URL: `recognize(canvas)` kosztuje w Chrome ok. 1 s na linię
  (toBlob na ponownie używanym canvasie), z data URL 20-50 ms.
- Wynik na sesji `samples/debug/2026-11-14_15-32-36`: 57 zdarzeń dla 57 nowych linii, 13/13 par klatek
  dopasowanych (stary potok: 89 zdarzeń). Pozostałe błędy to literówki OCR w nazwach ("Soidier", "Vamish",
  "spintshot"), czyli zakres E3.
- Klatka odniesienia (2026-11-14, po próbce `samples/debug/2026-11-14_20-28-46`): ruch kamery psuł na jedną
  klatkę maskę tekstu (tło za czatem), taka klatka stawała się odniesieniem i następna dobra wyglądała na
  całkiem nową, więc cały widoczny czat wchodził drugi raz do OCR i do zdarzeń. Teraz klatka niepasująca do
  odniesienia jest pomijana (oczekujące linie nietknięte); odniesienie zmienia się dopiero po 3 zgodnych ze sobą
  klatkach (resynchronizacja). Linie z resynchronizacji, ze skoku o 8+ linii w jednej klatce i po przewinięciu
  czatu w górę (dopasowanie z ujemnym przesunięciem) są partią podejrzaną: po odczycie porównane po kolei
  z ostatnimi 150 tekstami linii (te same liczby, podobieństwo 0.85, co najmniej 60% trafień w kolejności)
  i powtórki odpadają; teksty zastanych linii są czytane przy starcie do tej historii, bez zdarzeń. Testy
  w przeglądarce: klatki z symulowanym ruchem kamery i stałą zmianą tła 0 zdarzeń, przewinięcie o 2 linie
  i powrót 0 zdarzeń, sekwencja 15-32-36 nadal 57 zdarzeń także z wtrąconymi zepsutymi klatkami.

### E2. Maska kolorów i lepsza binaryzacja

Cel: stabilny obraz wejściowy, odporny na tło.

- Zamiast "jasne piksele" maska po kolorze tekstu: komunikaty mają kilka stałych barw (biały, żółty XP,
  zielony drop, czerwony otrzymane obrażenia). Piksel jest tekstem, gdy jest blisko jednej z barw
  w przestrzeni koloru, a tło, nawet jasne, odpada. Barwy do pobrania z Twoich próbek, z możliwością
  kalibracji kliknięciem na podglądzie.
- Dominująca barwa linii jako dodatkowy sygnał: żółta linia nie może być dropem, zielona nie może być XP.
  Zawęża kandydatów szablonów i wyłapuje pomyłki.
- Binaryzacja lokalna (Sauvola lub adaptacyjna średnia) zamiast jednego progu, dla przypadków bez wyraźnej
  barwy.
- Lekkie domknięcie morfologiczne i usunięcie plamek mniejszych niż najmniejsza litera.
- Upscaling 3x z interpolacją zamiast 2x, jeśli test pokaże zysk w dokładności.

Wpływ: średni do wysokiego dla jakości OCR, wysoki dla stabilności odcisków z E1.

### E3. Dopasowanie do słownika zamiast wyrażeń regularnych

Cel: koniec literówek w nazwach, jeden przedmiot to jedna pozycja.

- Dopasowanie szablonu: odległość edycyjna między linią z OCR a szkieletem szablonu, w której placeholdery
  pochłaniają dowolny fragment, a typowe konfuzje OCR (l/1/I/|, O/0, rn/m, cl/d, 5/S, 8/B, e/c) kosztują
  mniej niż zwykła pomyłka. Wybór szablonu o najniższym koszcie na literę, akceptacja powyżej progu.
  Kandydaci zawężani po pierwszym słowie, długości i barwie linii. Lista ręcznych poprawek OCR staje się
  zbędna.
- Kanonizacja pól: wartość z placeholdera jest sprowadzana do najbliższej nazwy ze słownika właściwego dla
  pola: `item` do listy przedmiotów, `target`/`src` do potworów, `skill` do umiejętności, z tym samym
  kosztem konfuzji. Wynik to identyfikator z bazy gry; nazwa wyświetlana zawsze z bazy, nigdy z OCR.
- Kontekst jako priorytet: przy kanonizacji dropu preferowane są przedmioty z tabeli dropów ostatnio
  zabitego potwora; przy celu potwory o poziomie zbliżonym do ostatnio spotykanych. XP z komunikatu
  porównywane z tabelą expa potwora (po uwzględnieniu mnożnika serwera, wyliczanego z sesji) jako test
  wiarygodności odczytu liczby.
- Liczby: kanonizacja cyfr po konfuzjach, odrzucenie wartości poza zakresem (np. obrażenia ponad kilkukrotność
  mediany z sesji trafiają do `unknown`).
- Placeholder pozostaje wolnym tekstem tylko tam, gdzie słownik nie istnieje (imiona graczy).

Wpływ: wysoki dla łupów i celów, średni dla reszty.

**Stan (2026-11-14): wdrożone** w `js/messages.js` (wyrażenia regularne zostały tylko jako wzorce zapasowe bez bazy):

- Dopasowanie szablonu: programowanie dynamiczne po znakach, placeholder pochłania dowolny niepusty fragment
  za darmo, zamiana znaku 1, w parach mylonych przez OCR 0.3 (o/0, l/1/i, s/5, a/g, e/c, ...), pary dwuznakowe
  (m/rn, n/ri, d/cl, h/li) 0.3, brakujący lub dodatkowy znak 1 (spacja 0.3). Przy remisie placeholder woli
  ciągnąć się dalej, więc "$s2 $s1" dzieli "3 Animal Bone" na "3" i "Animal Bone".
- Akceptacja: koszt do 0.25 na literę stałą szablonu (krótkie szablony prawie bez błędów). Przy podobnym
  koszcie wygrywa szablon z większą liczbą liter stałych ("You have obtained $s1 Adena" przed "$s1 Adena").
- Kandydaci: zgodność dwóch pierwszych słów (odległość Levenshteina z tolerancją) albo, dla szablonów
  zaczynających się od placeholdera, obecność słowa kotwicznego gdziekolwiek w linii.
- Kanonizacja: `item` do przedmiotów, `src`/`target`/`who` do potworów (imię gracza sprawdzane najpierw),
  `skill` do umiejętności; ten sam koszt edycyjny podzielony przez długość nazwy, próg 0.25, premia 0.06
  dla przedmiotów z dropu/spoilu pięciu ostatnio spotkanych potworów. W zdarzeniu nazwa z bazy plus pole
  `itemId`/`targetId`/`srcId`/`skillId`; wartości spoza słownika zostają surowe (imiona graczy) po teście
  `validName`. Pole `conf` = 1 - koszt na literę.
- Liczby: cyfry po poprawieniu pomyłek (O/Q/@ -> 0, l/I -> 1, S -> 5, B -> 8); fragment, który nie jest liczbą,
  odrzuca szablon i próbowany jest następny.
- Dane: w CSV jeden wpis miał "None Grade", klient pokazuje "No Grade"; `build_gamedata.py` to ujednolica.
- Nie wdrożone (zakres E4): test wiarygodności XP względem tabeli expa potwora i odrzucanie obrażeń poza
  zakresem sesji.
- Wynik: korpus linii z sesji debug (w tym "Vamish", "Pattem", "Soidier", "Sgiritshot - Ho Grade", "Jou use",
  "Ypu have obtained") klasyfikuje się poprawnie z nazwami z bazy; 57 zdarzeń z symulacji E1 bez żadnego
  `other`. Czas: 1-40 ms na linię (najdłużej kanonizacja nazw przedmiotów).

### E4. Pewność, potwierdzanie i lista "nieznane"

- Pewność z Tesseracta na poziomie słów; linia o niskiej pewności czeka na drugi, zgodny odczyt (dziś czeka
  tylko na obecność w następnej klatce).
- Zdarzenie powstaje dopiero, gdy: odcisk linii jest nowy (E1), szablon dopasowany powyżej progu (E3), pola
  skanonizowane powyżej progu (E3) i barwa linii zgadza się z typem (E2). Każdy brak to `unknown`.
- Panel "nierozpoznane" w sesji: surowy tekst, miniatura linii, powód odrzucenia. Z niego rosną słowniki
  i poprawki, zamiast z domysłów.

**Stan (2026-11-14): wdrożone** w `js/ocr.js`, `js/messages.js`, `js/dashboard.js`:

- Pewność z Tesseracta: pewność linii i najsłabszego słowa (słowa o co najmniej 2 znakach). Odczyt jest
  dobry przy linii >= 85 i słowie >= 70 (z próbek: poprawne linie 88-96, błędne "fend Siu" 77/31,
  "Sifu" 78/42; "wom" 93/90 i "LadySaisa" 89/84 przechodzą, ich pilnuje słownik z E3). Zły odczyt czeka
  na kolejną klatkę i jest czytany ponownie z nowych pikseli; koniec po dobrym odczycie, dwóch zgodnych
  albo trzech próbach. Zdarzenie ma `fields.ocr` (pewność najlepszego odczytu).
- Zdarzenie powstaje, gdy: odcisk nowy (E1), szablon dopasowany (E3), pola przechodzą walidację (E3).
  Każdy brak to typ `other` z `fields.reason`: `no_template`, `bad_fields`, `fragment` (linia bez dwóch
  słów i bez poprzednika), `empty`, `low_confidence` (odczyt słaby bez zgodnego powtórzenia, a szablon nie
  pasuje niemal dokładnie; `fields.wouldBe` mówi, jaki typ by wyszedł). Nazwa spoza bazy nie blokuje
  zdarzenia (łupy liczą się pod surową nazwą), ale dostaje `reason: unknown_item` / `unknown_skill`
  i trafia do panelu, bo brak w bazie to problem danych, nie odczytu.
- Barwa linii (E2): `fields.color` = dominująca klasa barwy maski (`beige`, `cyan`, `red`, `mixed`).
  Zapisywana do analizy, nie bramkuje typu: w próbkach wszystkie komunikaty są beżowe, więc mapowanie
  barwa -> typ wymaga sesji z kolorowymi wpisami (drop, szept, krzyk).
- Panel "Nierozpoznane" w każdej instancji dashboardu (sesja bieżąca i historia): czas, miniatura linii
  (obraz, jaki dostał silnik OCR, zapisany w zdarzeniu jako `thumb`, PNG ok. 1-2 KB), powód z pewnością OCR,
  odczyt. Ostatnie 100, licznik w nagłówku.
- Nie porównujemy XP z tabelą expa potwora (zależy od różnicy poziomów i składu drużyny).
- Test: symulacja na 14 klatkach bez zmian (57 zdarzeń, 0 nierozpoznanych); klatka z 35 nowymi liniami:
  3 linie o pewności 77-81 poszły do ponownego odczytu w następnej klatce i wyszły jako zdarzenia po
  zgodnym powtórzeniu, "You have played for 3 hour(s)..." trafiło do panelu jako `no_template` z miniaturą.

### E5. Zestaw regresyjny

- Korpus: wycinki klatek (PNG) plus oczekiwane zdarzenia w JSON, zbierane z Twoich sesji, w tym przypadki
  z szumem tła i przewijaniem.
- Skrypt (Node lub strona testowa) uruchamia cały potok na korpusie i liczy: trafność typu zdarzenia,
  trafność pól, liczbę duplikatów, liczbę `unknown`. Każda zmiana w E1 do E4 musi poprawiać wynik albo go
  nie pogarszać.

### E6. Opcjonalnie: własny rozpoznawacz czcionki gry

Czcionka czatu jest stała i bitmapowa. Po E1 mamy wycięte linie w stałej skali, więc możliwy jest prosty
klasyfikator glifów: segmentacja na znaki po kolumnach, porównanie z atlasem glifów zebranym z próbek
(k najbliższych sąsiadów na bitmapach). Taki rozpoznawacz jest deterministyczny, działa w milisekundach
i nie zna pojęcia "rn" czy "m" z kontekstu. Wysiłek jest większy (zebranie atlasu, obsługa kerningu),
dlatego wchodzi w grę tylko, jeśli po E1 do E4 OCR nadal będzie wąskim gardłem.

Nie planuję opierać się na słownikach wbudowanych w Tesseracta (lista dozwolonych znaków, słowa
użytkownika, wzorce): raporty użytkowników są sprzeczne co do tego, czy silnik LSTM je honoruje,
a wiarygodnie działają tylko w starym silniku. Słownik trafia więc po stronie aplikacji (E3), gdzie mamy nad
nim pełną kontrolę. Jedyny szybki eksperyment: porównać na korpusie stary silnik z listą znaków i silnik
LSTM, i zostać przy lepszym.

## 4. Zmiany w danych

Zdarzenie zyskuje pola: `msgId`, `itemId`/`monsterId`/`skillId` (gdy dotyczy), `raw` (tekst z OCR),
`confidence`, `lineHash`, a typ `unknown` dla odrzuconych. Tabela łupów i wykresy grupują po identyfikatorach,
nazwy biorą z bazy gry. Stare sesje bez identyfikatorów pozostają czytelne (nazwa z `raw`).

## 5. Kolejność i co jest potrzebne

Kolejność: E5 (żeby mierzyć) → E1 → E2 → E3 → E4 → ewentualnie E6. E1 i E3 dają największy zysk i są
niezależne, więc można je rozwijać równolegle.

Od Ciebie:
- kilkanaście wycinków klatek z różnych sytuacji (jasne tło, ciemne tło, ruch kamery, szybkie przewijanie,
  dropy z nazwami, zużycie shotów), najlepiej jako pełne PNG obszaru czatu w oryginalnej skali: będą korpusem
  E5 i źródłem barw dla E2;
- potwierdzenie, że kolory komunikatów w Twoim kliencie są stałe (standardowe albo Twoje własne z okna
  System Msg);
- decyzja, czy E6 ma być w planie od razu, czy dopiero po ocenie wyników E1 do E4.

## 6. Plan 2026-11-15: maska bez barwy i rewizje zdarzeń wstecz

Stan: plan do akceptacji, nic z poniższego nie jest wdrożone.

### Co pokazała próbka z przezroczystym czatem (`samples/debug/debug/2026-11-15_18-48-41`)

Sesja 10 minut, bez tła pod czatem (tekst leży wprost na trawie i lesie).

| miara | wartość |
|---|---|
| klatek / dopasowanych / niedopasowanych / resynchronizacji | 2280 / 2210 / 69 / 12 |
| odczytów OCR, w tym powtórnych | 1264, 659 (52%) |
| nierozpoznanych w sesji (`nierozpoznane-2026-11-15T17-45-30.json`) | 129: 89 brak szablonu, 22 złe pola, 18 niska pewność |
| pewność OCR nierozpoznanych | głównie 40-70 |

Typowe odczyty: "inflicted" jako "nfl ted", "mfl cted", "infin ted"; "Keltir" jako "helt", "elt", "Keltin";
"received" jako "recened"; "from" jako "fiom"; "11" jako "1v". Pomiary pikseli wyjaśniają dlaczego:

- Tekst czatu bez podkładki jest ciemniejszy i przejmuje barwę tła: nad lasem jasność 0.60-0.70 przy nasyceniu
  0.10-0.25, nad trawą odcień 60-85 (zielonkawy). Obecna maska wymaga jasności > 0.64 i odcienia 25-75, więc
  część pikseli glifów odpada po obu stronach progu. Na jasnej klatce 27% pikseli tekstu ma odcień powyżej 75.
  Maska binarna (`-bin.png`) pokazuje litery z dziurami, które silnik czyta jak powyżej.
- Glify mają ciemną obwódkę ze wszystkich stron, nie pojedynczy cień: dla pikseli tekstu ciemny sąsiad jest
  na +1,+1 w 79%, na -1,-1 w 70%, z boków 53-63%, z góry i z dołu 30-35%. Obwódka nie zależy od barwy tekstu.
- Maska bez barwy, strukturalna (piksel jasny > 0.5 i co najmniej 3 ciemne z 8 sąsiadów albo ciemny sąsiad
  w obu osiach): na klatce ciemnej i jasnej (`18-54-42`, czat nad trawą z potworem) wszystkie 25 linii
  segmentują się jak dziś, z 1.5-1.8 razy większą liczbą pikseli na linię (np. 515 zamiast 300), glify w całości,
  szum minimalny. Naiwna maska "jasny piksel z ciemnym w promieniu 2 px" nie wystarcza: na trawie zlewa
  sąsiednie linie (pasy 37-66 jako jeden).
- Barwa nie bramkuje dziś niczego (`fields.color` jest tylko etykietą), więc zgłoszenia o własnych kolorach
  komunikatów dotyczą wyłącznie maski: komunikat w barwie spoza trzech klas znika z maski w całości.
- Próbka z kolorami (`samples/colors-chat.png`: ten sam komunikat w czerwieni, pomarańczu, beżu, fiolecie
  i bieli nad trawą; `samples/colors-palette.png`: 13 kolorów domyślnej palety klienta). Obecna maska gubi
  w całości linie pomarańczowe (nasycenie powyżej 0.72) i fioletową (odcień 300): 0 pikseli. Maska
  strukturalna z progiem jasności 0.5 segmentuje 23/23 linie, każdą barwę z 550-720 pikselami; próg 0.4 daje
  to samo. Wszystkie kolory palety są jasne w sensie najjaśniejszego kanału (czerwień, magenta i zieleń też),
  więc próg jasności nie wyklucza żadnego z nich; zmierzona jasność pikseli tekstu nad trawą: 0.72-0.93.

### E7. Maska tekstu bez barwy

Cel: tekst w dowolnym kolorze, na dowolnym tle, z pełnymi glifami.

- `textMask`: piksel jest tekstem, gdy jest jasny i ma strukturę obwódki (jak w pomiarze wyżej); bez klas
  barwy. Próg jasności do zmierzenia (0.45-0.5): niżej wchodzą ciemne komunikaty użytkownika, wyżej mniej szumu.
  Maska `soft` dla obrazu OCR zostaje (kropki nad i, ogonki): kandydat z ciemnym pikselem w promieniu 2 px.
- Barwa jako etykieta: dominujący odcień i nasycenie pikseli linii dalej trafiają do `fields.color`
  (nazwy klas rozszerzone o zielony, niebieski, fioletowy, biały), wyłącznie do analizy.
- Próg odcisku: maska ma więcej pikseli, więc rozkład odległości tej samej i innych linii się zmienia.
  `tools/ocr_fingerprint.py` dostaje tę samą maskę i liczy progi na trzech sesjach debug; THRESHOLD 0.25 do
  potwierdzenia albo zmiany.
- Ryzyka do sprawdzenia na próbkach: jasne elementy z ciemną obwódką poza czatem (ramka okna, ikony przy linii,
  etykiety nazw potworów nad czatem, jak "Bearded Keltir" w próbce, która już dziś wchodzi do maski); linie
  z nimi dopasowuje E1 z tolerancją, ale warto policzyć, ile klatek przez nie wypada.
- Test: potok na trzech sesjach debug w przeglądarce (harness jak przy E1), porównanie: liczba zdarzeń,
  nierozpoznanych, powtórnych odczytów, pewność OCR. Sekwencja `15-32-36` ma dać nadal 57 zdarzeń,
  sesja przezroczysta wyraźnie mniej niż 129 nierozpoznanych i mniej niż 52% powtórnych odczytów.

Wpływ: wysoki; usuwa przyczynę większości dzisiejszych nierozpoznanych i uniezależnia od kolorów klienta.

**Stan (2026-11-15): wdrożone** w `js/image.js` (`textMask`, `colorClass`) i `tools/ocr_fingerprint.py`:

- Piksel jest tekstem, gdy jego najjaśniejszy kanał przekracza 0.5 i ma obwódkę: ciemne co najmniej 3 z 8 sąsiadów
  albo ciemny sąsiad w obu osiach. "Ciemny" jest względny: poniżej 0.33 albo poniżej 60% jasności piksela
  (najwyżej 0.45). Próg stały 0.33 nie wystarczał: przy półprzezroczystej podkładce nad jasną sceną obwódka
  rozjaśnia się i połowa glifu znikała (sesja `15-32-36`, klatka `15-33-56`: 9.5 tys. zamiast 13.9 tys. pikseli,
  dwie klatki niedopasowane, 53 zdarzenia zamiast 57).
- Luźna maska do obrazu OCR: jasność powyżej 0.34 i ta sama reguła obwódki, tylko ostrzejsza (ciemne co najmniej
  5 z 8 sąsiadów albo ciemny sąsiad w obu osiach). Pierwsza wersja ("ciemny sąsiad w promieniu 1 px") dawała halo:
  przy półprzezroczystej podkładce nad jasną sceną tło tuż za obwódką ma jasność 0.35-0.5 i wchodziło do obrazu OCR
  jako szary pierścień wokół każdej litery; w sesji na żywo (eksport `samples/debug/nierozpoznane-2026-11-15T19-33-16.json`)
  wszystkie 13 nierozpoznanych linii miało pewność 35-76 z odczytami typu "Arath fies inflicted L3 danage op Well".
  Z regułą obwódki na klatce `15-33-56` 24 zamiast 14 dobrych linii na 37, na `18-54-42` (trawa) 5 zamiast 0,
  średnia pewność 85 zamiast 79 i 81 zamiast 67. Barwa została etykietą: `fields.color` z klas beige, yellow, orange, red, green, cyan, blue, purple,
  white, mixed; na przezroczystym czacie tekst przejmuje odcień tła i etykieta wychodzi najczęściej `mixed`
  (189 z 216 zdarzeń), więc do analizy nadaje się tylko przy podkładce.
- Jasność piksela to luminancja z zachowaniem nasyconych barw (`lightness` = max z luminancji, 0.9 R, 0.8 G, 0.6 B),
  nie najjaśniejszy kanał. Sesja z czatem nad niebem (`samples/debug/2026-11-15_20-46-33`, `2026-11-15_20-50-06`,
  eksport `nierozpoznane-2026-11-15T19-42-41.json`: 70 nierozpoznanych, pewność 20-50, 16% klatek niedopasowanych):
  niebieska podkładka (rgb ok. 40,70,170) ma najjaśniejszy kanał 0.67 jak beżowy tekst, więc wchodziła do maski
  jako tekst, a glify rozpadały się na strzępy; w luminancji podkładka ma 0.28, tekst 0.65-0.75, obwódka 0.1-0.2.
  Pomiar na klatkach z nieba: pewność OCR 30-37 -> 90, dobrych linii 0 -> 14-18 na 23; trawa 81.5 -> 87, próbka
  kolorów 88.9 -> 91.5, reszta bez zmian. Sama luminancja gubi czerwień palety (255,12,12 ma 0.33) i jest na granicy
  dla turkusu (0.55), stąd wagi kanałów; wszystkie 13 barw palety ma jasność od 0.62. Czysty błękit (0,0,255)
  nie przejdzie (0.6), ale nie ma go w palecie. Obserwacja z E8 nie mogła tych linii poprawić, bo na niebie każdy
  kolejny odczyt był równie zły: poprawki działają tylko, gdy któryś odczyt jest dobry.
- Próg odcisku 0.25 zostaje: na wszystkich 36 parach klatek trzech sesji debug najlepsze przesunięcie ma średnią
  odległość do 0.19, drugie najlepsze od 0.22 (poza parami, gdzie czat jest okresowy i oba przesunięcia są
  prawdziwe).
- Wyniki potoku w przeglądarce (klatki co 15 s, więc skoki o kilkanaście linii i partie podejrzane):

  | sesja | przed | po |
  |---|---|---|
  | `15-32-36` (podkładka, jasne tło) | 57 zdarzeń, 0 nierozpoznanych, 0 powtórek OCR, pewność 93.8 | 57 zdarzeń, 0 nierozpoznanych, 1 powtórka na 96 odczytów, pewność 93.6 |
  | `20-28-46` (ruch kamery) | 0 zdarzeń | 0 zdarzeń |
  | `18-48-41` (czat przezroczysty) | 158 zdarzeń, 4 nierozpoznane, 252 powtórki na 469 odczytów (54%), pewność 87.7, 4 klatki niedopasowane | 229 zdarzeń, 0 nierozpoznanych, 109 powtórek na 381 (29%), pewność 91.9, 0 niedopasowanych |
  | `20-46-33` (czat nad niebem, 8 klatek) | (stara maska niemierzona; na żywo 70 nierozpoznanych) | 57 zdarzeń, 2 nierozpoznane ("received: 11 damage" z dwukropkiem, "Over-hit!" jako fragment), 41 powtórek na 124, pewność 87.4, 7/7 klatek dopasowanych |

  Z pierwszą (luźniejszą) wersją luźnej maski sesja `15-32-36` miała jedną nierozpoznaną: "You have acquired 255 XP
  and 9/SP" w klatce z białym niebem za gałęziami (jasne niebo przy ciemnej gałęzi wchodziło między "9" a "SP"
  jako szary ślad); z regułą obwódki linia czyta się poprawnie.
- Próbka kolorów (`samples/colors-chat.png`, pojedynczy odczyt każdej linii bez powtórek): 23/23 linie
  segmentowane, 21 sklasyfikowanych poprawnie (czerwone, pomarańczowe, fioletowe i białe tak samo jak beżowe);
  dwie z ikoną paska przewijania przy lewej krawędzi dostały śmieć przed tekstem, który w potoku czyści
  `cleanOne`.
- Narzędzie `tools/ocr_fingerprint.py` ma tę samą maskę, ale nie było uruchamiane (brak pillow i numpy
  w tym środowisku).

### E8. Obserwacja linii i rewizja zdarzeń wstecz

Cel: zdarzenie wychodzi od razu, ale linia jest obserwowana, dopóki jest widoczna; lepszy odczyt poprawia
zdarzenie w miejscu, łącznie ze statystykami.

Dziś: linia dostaje do 3 odczytów, tylko dopóki nie jest "ustalona"; zdarzenie jest emitowane raz, bez
identyfikatora na obiekcie; dashboard przelicza wszystko z `view.events` co 1.5 s, SQLite jest budowany od
nowa przy autozapisie, wiersze logu nie mają klucza.

- Tożsamość zdarzenia: `ev.id` z IndexedDB (klucz z `add`) zapisany na obiekcie; `db.put` do aktualizacji.
- Cykl życia linii: nowa -> odczyt -> emisja (jak dziś, bez opóźnienia) -> obserwowana -> zamknięta.
  Obserwowana linia trzyma odcisk i listę odczytów w `state.watch`. Kolejny odczyt tylko, gdy piksele pod nią
  realnie się zmieniły (odległość odcisku do maski z ostatniego odczytu powyżej ok. 0.1, czyli inne tło po
  ruchu kamery), bo ten sam obraz da ten sam wynik. Limity: łącznie do 5 odczytów, obserwacja do zniknięcia
  linii z okna (bez limitu czasu, decyzja z 2026-11-15); nowe linie mają pierwszeństwo przed powtórkami
  (budżet OCR ok. 45 ms na linię przy 4 klatkach na sekundę).
- Wybór najlepszego odczytu: nie sama pewność OCR, ale jakość klasyfikacji: szablon bez zastrzeżeń przed
  `unknown_item` przed `low_confidence` przed `bad_fields` przed `no_template`; przy równej jakości wyższa
  pewność OCR i zgodność z innym odczytem. Linia zamyka się wcześniej, gdy ma dwa zgodne odczyty bez
  zastrzeżeń. Głosowanie po znakach między odczytami to etap drugi, tylko jeśli pojedyncze odczyty nie wystarczą.
- Rewizja: gdy najlepszy odczyt zmienia tekst, typ albo pola, zdarzenie jest nadpisywane w miejscu (ten sam
  `id` i `ts`): nowy tekst, typ, pola, `fields.rev` (numer rewizji) i `fields.reads`; miniatura usuwana, gdy
  linia przestaje być nierozpoznana. `db.put`, nowy hak `onEventsUpdated` -> dashboard podmienia obiekt
  w `view.events` po `id`, odświeża wiersz logu (klucz `data-id`, znacznik rewizji) i planuje przeliczenie;
  kafelki, wykresy, łupy, zysk i panel nierozpoznanych liczą się z `view.events`, więc zmieniają się same.
  Eksporty i SQLite też, bo są budowane z tej listy.
- Komunikaty zawinięte (dwie linie): rewizja dotyczy obu linii naraz i ponownego sklejenia; w pierwszym
  kroku rewizje tylko dla komunikatów jednoliniowych, dwuliniowe zamykane przy emisji (ograniczenie opisane).
- Historia: sesje z bazy nie są obserwowane; rewizje dotyczą tylko trwającej sesji.
- Statystyki: `stats.revisions`, w panelu OCR liczba rewizji; w debugu lista odczytów obserwowanej linii.

Wpływ: średni po E7 (zostają linie, które nad jednym tłem czytają się źle, a po ruchu kamery dobrze);
wysoki na przezroczystym czacie, gdzie tło pod linią zmienia się co chwilę.

**Stan (2026-11-15): wdrożone** w `js/ocr.js` (`watchLines`, `bestRead`, `toEvent`), `js/storage.js` (`put`),
`js/dashboard.js` (`updateEvents`, znacznik ↻ w dzienniku), `js/app.js` (hak `onEventsUpdated`), `js/debug.js`:

- Zdarzenie z komunikatu jednoliniowego zostaje pod obserwacją (`state.watch`), dopóki linia jest na ekranie.
  Linia jest śledzona po pozycji: indeks w poprzedniej klatce minus przesunięcie z dopasowania klatek, z tolerancją
  ±1 pasa. Szukanie w całym oknie było błędne: w grindzie te same komunikaty wracają co chwilę i stara linia
  "podstawiała się" pod nowe, lista obserwowanych rosła bez końca (187 wpisów przy oknie 25 linii), a bliźniacza
  linia ("received 19 damage" obok "received 22 damage") podmieniała zdarzenie. Pozycja nieznana (partia
  wstrzymana, resynchronizacja) jest ustalana raz przez wyszukanie w oknie, tylko gdy jednoznaczne (druga
  najbliższa linia powyżej progu), inaczej obserwacja się kończy.
- Powtórny odczyt tylko, gdy maska linii różni się od maski z ostatniego odczytu o więcej niż 0.1, do 5 odczytów
  łącznie, najwyżej 2 na klatkę i tylko w ramach budżetu 4 odczytów OCR na klatkę po nowych liniach
  (`L2GL.ocr.limits`, do strojenia bez zmiany kodu).
- Wybór odczytu: jakość rozpoznania (szablon bez zastrzeżeń 4, z nazwą spoza bazy 3, niska pewność 2, złe pola
  lub fragment 1, brak szablonu 0), potem liczba zgodnych odczytów (ten sam tekst po oczyszczeniu, zgodność
  znosi zastrzeżenie niskiej pewności), na końcu pewność OCR. Poprawka wymaga lepszej jakości albo przewagi
  głosów: dwa dobre odczyty różniące się cyfrą nie zmieniają zdarzenia (w teście odczyt 93 kontra 95 pewności
  zamieniał "19" na "22"). Sama interpunkcja też nie jest poprawką.
- Poprawka w miejscu: ten sam `id` i `ts`, nowy tekst, typ, pola, `fields.rev` (numer poprawki) i `fields.reads`;
  miniatura usuwana, gdy linia przestaje być nierozpoznana. Zapis `db.put` po zakończeniu `db.add` (klucz
  IndexedDB w `ev.id`). Dashboard podmienia wiersz dziennika (znacznik ↻n z podpowiedzią) i przelicza widok;
  kafelki, wykresy, łupy, panel nierozpoznanych, eksporty i SQLite liczą się z tej samej listy zdarzeń.
- Komunikaty zawinięte (dwie linie) nie są obserwowane; sesje z historii też nie. Panel OCR pokazuje liczbę
  odczytów w obserwacji i poprawek, wpis debug ma `sync.watch`.
- Test w przeglądarce (klatki co 15 s, budżet odczytów zdjęty, bo każda klatka ma kilkanaście nowych linii):
  przebieg czysty: 26 i 50 powtórnych odczytów w obserwacji, 0 poprawek, zdarzenia jak w E7 (pomiar z pierwszą
  wersją luźnej maski: 57 i 216);
  przebieg z psuciem co trzeciego odczytu silnika (cyfra na "v", "inflicted" na "mfl cted", pewność 55):
  3 poprawki w sesji przezroczystej, wszystkie w dobrą stronę (brak szablonu albo złe pola -> obrażenia
  z poprawnymi liczbami), 0 błędnych. Reszta zepsutych linii wyszła z okna, zanim przyszła klatka z innym tłem;
  na żywo przy 4 klatkach na sekundę okazji jest więcej. Nie testowane z grą.

### Sesja 2026-11-15 20:15 (14 min, `samples/debug/2026-11-15_21-15-29`, eksport `nierozpoznane-2026-11-15T20-15-28.json`)

149 nierozpoznanych: 83 brak szablonu, 32 fragmenty, 18 złe pola, 8 niska pewność, 5 przedmiot spoza bazy.
Potok: 2965 klatek, 314 niedopasowanych (11%), 50 resynchronizacji, 24 poprawki wstecz (22 w dobrą stronę,
2 wątpliwe: zmiana cyfry między dwoma dobrymi odczytami przy przewadze głosów 2:1, "earned" na "eamed" też 2:1).
Przyczyny i co zrobiono:

- Piasek (20:16-20:17, 20:20-20:22): beżowy tekst na piaszczystym tle o tej samej jasności (tekst 0.55-0.67,
  tło 0.45-0.65). Maska rozpoznaje tylko piksele przy obwódce, obwódka nad jasnym piaskiem jest rozjaśniona
  (0.11-0.33, na granicy progu), litery wychodzą wydrążone, OCR 20-40. Żaden wariant progu obwódki nie pomaga
  (najlepszy 52 kosztem nieba), normalizacja obrazu też nie (31). **Nierozwiązane**: jedyną cechą tekstu na takim
  tle jest obwódka, więc wymagałoby to rozpoznawania po obwódce (E6). Obserwacja z E8 poprawia takie linie
  dopiero, gdy kamera zmieni tło.
- Obraz dla OCR z normalizacją kontrastu linii (`renderLine`): mediana jasności tekstu -> czerń, mediana obwódki
  -> biel; piksel spoza maski tylko, gdy dotyka obwódki. Pomiar: niebo 23/23 dobrych linii zamiast 14/23 (pewność
  92.9 zamiast 89.7), podkładka nad jasną sceną 30/37 zamiast 24/37, trawa 16/25 zamiast 9/25, próbka kolorów
  16/23 zamiast 19/23 (pewność 90.9 zamiast 91.5). Potok: czat przezroczysty 242 zdarzeń, powtórek 22 zamiast 109,
  pewność 92.9; sesja `15-32-36` pewność 94.2, 0 powtórek.
- "Over-hit!" (12 sztuk) odpadało jako fragment (jedno słowo); teraz krótka linia, która sama jest komunikatem
  z bazy, nie jest fragmentem ani kontynuacją zawiniętego komunikatu (`known` w `assemble` i `bestRead`).
- "You have earned Weapon Mastery." (5 sztuk) szło szablonem 54 jako łup z nazwą spoza bazy; gdy nazwa z pola
  przedmiotu jest umiejętnością, zdarzenie jest typu `msg` z `skill`/`skillId` (nie liczy się do łupów).
- Okna gry nad czatem (sklep: "Adena 1,562 Price", "Weight", zadania: "Quest") dają śmieci białe/niebieskie
  i resynchronizację; po zamknięciu okna wracające linie odrzuca `dropRepeated` (14 w tej sesji). Zostaje szum
  w panelu nierozpoznanych; do rozważenia bramka jakości dla partii z resynchronizacji.
- Sieroty "ume." / "time." (kontynuacja zawiniętego "re-use time." bez ogona): 3 sztuki, nie zbadane.
- Nic do dodania do bazy szablonów: wszystkie prawdziwe komunikaty z sesji w niej są ("Transaction completed.",
  "You have equipped your $s1.", "You obtained $s1 Recommendation(s).", "Attention: $c1 has picked up $s2.").
- Przedmioty questowe (2026-11-15): "You have earned Adamantite Ore." wychodziło jako łup "Adamantite Ring" (koszt
  0.22 poniżej progu 0.25, bo długi wspólny przedrostek rozmywa koszt całkiem innego słowa). Baza gry
  (lineage2wiki c1, `gamedb/items.csv`) nie ma przedmiotów questowych, więc nie da się ich dodać z danych.
  Kanonizacja nazw (`canon`, `wordsAgree` w `js/messages.js`) nie może zamieniać całych słów: każde słowo musi mieć
  odpowiednik na tej samej pozycji w granicach tolerancji literówek (1 dla słów do 3 liter, 2 do 6, 3 dłuższych);
  inna liczba słów (sklejone "YoungKeltir", rozbite "Bearded Kel tir") przechodzi tylko przy koszcie całości
  do 0.12. "Adamantite Ore" zostaje surową nazwą z zastrzeżeniem `unknown_item` (liczy się jako łup bez ceny
  i trafia do panelu nierozpoznanych), "Leather Stocklng", "Vamish", "Sgiritshot - Ho Grade", "Eider Wolf",
  "Elder Keftir", "Gant Toad" nadal dopasowują się do właściwych nazw.

### Eksperyment: łączenie wielu klatek tej samej linii (2026-11-15, nie wdrożone)

Pomysł: napis stoi w miejscu, tło się rusza, więc statystyka po klatkach powinna oddzielić tekst od tła. Test na
piasku (`samples/debug/2026-11-15_21-15-29`):

- Seria 8 klatek co 0.25 s: tło przesuwa się za mało (odległość masek 0.11-0.18). Maska "pikseli stabilnych
  w czasie" (odchylenie jasności poniżej progu) obejmuje tysiące pikseli piasku, pewność OCR 18-34 wobec 30 dla
  pojedynczej klatki. Średnia, mediana i minimum obrazu linii: 31, 33, 36.
- Klatki co 10 s (3-4 na linię, tło naprawdę inne): najlepszy pojedynczy odczyt (to, co robi E8) 43, średnia 26,
  mediana 24, maksimum 23, **minimum 51** (jedna linia dobra, np. "There are 2 second(s) remaining in Power" 59).
  Minimum działa, bo tekst jest jasny w każdej klatce, a najciemniejsze tło daje największy kontrast; średnia
  i mediana rozmywają glify przy niedokładnym nałożeniu (tu tylko ±2 px w pionie) i ciągną tło w stronę jasności
  tekstu.

Wniosek: ma sens tylko jako minimum (albo inna statystyka "najciemniejszego tła") z klatek o wyraźnie innym tle,
zbieranych przez cały czas życia linii, z nałożeniem co do piksela w obu osiach. Zysk przy 3-4 klatkach jest
umiarkowany; rośnie z liczbą różnych teł. Pasuje do E8 (obserwacja już śledzi linię i wykrywa zmianę tła), koszt:
pamięć na obraz linii z każdej "nowej" klatki i jedno dodatkowe rozpoznanie na obrazie minimum. Nie wdrożone.

Uwaga do źródła różnych teł: czat przewija się o całe wiersze, więc ta sama linia odwiedza do ok. 25 pozycji
na ekranie i pod każdą ma inny fragment tła nawet przy nieruchomej kamerze; przesunięcie jest całkowite, więc
nałożenie jest dokładne co do piksela (do sprawdzenia: ±1 px przy segmentacji pasów). To daje kilkadziesiąt
różnych klatek na linię zamiast 3-4 z testu wyżej.

Metody z literatury (2026-11-15):

- Minimum po klatkach dla jasnego tekstu (maksimum dla ciemnego): Sato, Kanade i in., "Video OCR: indexing
  digital news libraries by recognition of superimposed captions" (Multimedia Systems 1998) powiększają blok tekstu
  4x i integrują w czasie "time-based minimum pixel value search"; założenie: napis jaśniejszy od tła. To jest
  wariant, który jako jedyny pomógł w teście wyżej.
- Śledzenie linii z dokładnością podpikselową i jedna bitmapa linii z całego jej wystąpienia: Lienhart, Wernicke,
  "Localizing and segmenting text in images and videos" (IEEE TCSVT 2002); redundancja czasowa podniosła
  skuteczność lokalizacji z 69.5% do 94.7%.
- Rozkład "stały napis z przezroczystością nad zmiennym tłem" na matę alfa i kolor napisu z wielu obrazów:
  Dekel, Rubinstein, Liu, Freeman, "On the Effectiveness of Visible Watermarks" (CVPR 2017); u nas uproszczenie
  per piksel: wariancja jasności w czasie jest mała dla pikseli napisu (alfa bliska 1) i duża dla tła, więc
  z kilkudziesięciu klatek wychodzi mata alfa glifów (kształt liter z wygładzeniem) niezależna od koloru tekstu i tła.
  W teście na 8 klatkach z 2 s nie działało tylko dlatego, że tło się nie zmieniło; przy pozycjach z przewijania
  powinno.
- Łączenie wyników OCR z wielu klatek na poziomie znaków (ROVER: nałożenie hipotez po odległości edycyjnej
  i głosowanie na każdej pozycji, z wagą pewności): Chen, Odobez, "Video text recognition using sequential Monte
  Carlo and error voting methods" (2005); Bulatov i in., "Methods of weighted combination for text field recognition
  in a video stream" (2019). U nas `bestRead` głosuje na całe linie; głosowanie po znakach to tani krok wyżej
  i działa też, gdy żaden pojedynczy odczyt nie jest w całości dobry.

Proponowana kolejność, gdyby wdrażać: (1) akumulacja obrazu linii przez całe życie linii z nałożeniem po
przesunięciu z dopasowania klatek, (2) mata alfa z wariancji + minimum jako obraz dla OCR, czytany tylko, gdy
odczyty pojedynczych klatek są słabe, (3) głosowanie po znakach w `bestRead`.

**Stan (2026-11-15, strumień 491 klatek `samples/debug/2026-11-15_22-07-20`, opcja "każda klatka"):**

- Eksperyment poza potokiem (własne śledzenie linii przez całe życie, akumulacja klatek o zmienionym tle,
  odczyt na końcu): 143 linii z 3-59 klatkami; obraz minimum 125/143 dobrych, pewność 92.7; najlepszy pojedynczy
  odczyt 104/143, 90.0; maska z wariancji 93/143, 87.4. Minimum lepsze o 10+ punktów dla 21 linii, gorsze dla 1.
  Linie słabe (pojedynczy odczyt poniżej 75): 6, średnio 64.8 -> 83.0 z minimum.
- Wdrożone w `js/ocr.js` (`accumulate`, `minLine`, `limits.minFrames`): obserwowana linia akumuluje obraz minimum
  RGB z klatek o tle innym niż ostatnio zaakumulowane (odległość odcisku powyżej 0.08), z nałożeniem w pionie ±2 px
  po pokryciu masek z pierwszą klatką; od `minFrames` (3) klatek powtórny odczyt linii rozpoznanej z zastrzeżeniem
  idzie z obrazu minimum (maska i obraz OCR liczone na nim jak na klatce). Czystych odczytów obraz minimum nie
  rusza, a w głosowaniu liczy się tylko ostatni odczyt z minimum: pierwsza wersja liczyła każdy i dwa odczyty
  z tego samego obrazu przegłosowały poprawne "53 damage" (pewność 95) na "16".
- Odtworzenie całego strumienia przez prawdziwy potok: bez zmian (96 zdarzeń, 23 nierozpoznane, pewność 81.9,
  z minimum i bez). Przyczyna: 22 z 23 nierozpoznanych linii było obserwowanych tylko ok. 3 klatki (jedna klatka
  zaakumulowana), bo pochodzą z okresów na piasku, gdzie klatki nie pasują do odniesienia (140 z 491
  niedopasowanych, 19 resynchronizacji), a po resynchronizacji odnalezienie linii po odcisku zawodzi, bo maska
  na piasku jest niestabilna. Obraz minimum pomaga tylko liniom, które potok potrafi śledzić, a te na piasku
  i tak czytają się nieźle. **Wąskie gardło to śledzenie linii w okresach niedopasowania, nie OCR.** Kierunek:
  nie kończyć obserwacji przy resynchronizacji, tylko odnajdywać linie po powrocie dopasowania (zakładając małe
  przesunięcie przy krótkiej przerwie) albo dopasowywać klatki na masce mniej czułej na tło.
- Wątpliwe poprawki "cyfra na cyfrę" przy przewadze głosów 2:1 z pojedynczych klatek (16 -> 14, 12 -> 11) zostają
  do zbadania na tym strumieniu (są w `revisionsSinceLast` i w `rec-*.bin`).

**Śledzenie linii po pozycji także dla oczekujących (2026-11-15, `locate`, `missed` w `js/ocr.js`):**

- Dotąd linia oczekująca była szukana w każdej klatce w całym oknie z progiem 0.25 i gdy maska na jedną klatkę
  była nie do poznania (piasek, ruch kamery), po cichu wypadała z kolejki bez zdarzenia; w następnej klatce nie była
  już "nowa" (leżała w części wspólnej), więc znikała na zawsze. Odtworzenie strumienia 491 klatek: 96 zdarzeń.
- Teraz oczekujące i obserwowane linie są śledzone tak samo: oczekiwany indeks minus przesunięcie z dopasowania,
  tolerancja ±1 pasa i luźny próg 0.4 (pozycja jest mocnym dowodem), w razie niepowodzenia jednoznaczne wyszukanie
  w oknie, a linia nie do poznania przez 2 kolejne klatki dopiero wtedy jest uznana za zniknięta; linia, która
  wyjechała z okna z jakimkolwiek odczytem, jest emitowana z tym, co ma; bez odczytu liczona w `stats.lost`.
- Ten sam strumień: 292 zdarzenia (121 nierozpoznanych, 18 poprawek wstecz, wszystkie z "inne" na właściwy typ
  albo poprawka literówki), 55 linii straconych bez odczytu (nie do poznania przez 3 klatki od pojawienia się,
  piasek). Sesje regresyjne: `15-32-36` 57/0, `20-46-33` 57/1, `18-48-41` (klatki co 15 s) 174 zamiast 242 i 77
  "straconych": artefakt rzadkiego próbkowania, przy którym dopasowanie klatek bywa błędne (ujemne przesunięcie
  przy powtarzalnym czacie) i linie "wyjeżdżają" między próbkami; przy 4 klatkach na sekundę przesunięcie to 0-2 linie.
- Liczba prób odczytu linii oczekującej (`limits.maxReads`): 3 kontra 6 na tym strumieniu: nierozpoznanych 121 kontra
  125, mediana opóźnienia emisji 3.0 s kontra 3.5 s, poprawek wstecz 18 kontra 5 (więcej prób przed emisją zużywa
  limit 5 odczytów na linię i zostawia mniej na obserwację). Kolejne odczyty tej samej klatki nic nie wnoszą, bo tło
  się nie zmienia; wartość mają odczyty po zmianie tła, a te robi obserwacja. Zostaje 3.

### Tryb debug po E7 i E8 (2026-11-15)

`js/debug.js`: próbka co 10 s (wycinek PNG, maska, wpis JSONL), co minutę pełna klatka okna (JPEG) i seria 8 kolejnych
klatek wycinka w tempie potoku (`-b0..b7-crop.png`, odstęp ok. 260 ms; zrzuty najpierw, kodowanie PNG po serii, bo
kodowanie trwa ok. 1 s na klatkę). Wpis JSONL ma dodatkowo: `burst` (pliki serii), `settings.limits`, `pending`
z numerem partii, `watch` (obserwowane linie: pozycja, jakość, odczyty, zdarzenie), `revisionsSinceLast` (poprawki
wstecz: przed, po, wszystkie odczyty linii), `droppedSinceLast` (partie odrzucone jako powtórki), `stats.frameMsTotal`.
Rozmiar ok. 300 MB na godzinę. Próbka z serią trwa ok. 13 s, więc kolejna próbka po niej wypada.

Opcja "każda klatka" (pole wyboru przy przycisku Debug, od 2026-11-15): każda klatka wycinka, jaką dostaje potok
(4 na sekundę), zapisywana surowo w paczkach `rec-<stamp>-<nr>.bin` po 60 klatek (ok. 25 MB przy wycinku 327x422,
ok. 100 MB na minutę), spis w `rec.jsonl` (plik, wymiary, czasy klatek). Klatka w paczce: nagłówek 16 bajtów
(uint32 LE: czas ms modulo 2^32, szerokość, wysokość, 0) i w*h*3 bajtów RGB. Bez kompresji, bo kodowanie PNG
trwa ok. 1 s na klatkę; kopia klatki kosztuje ułamek ms, zapis paczki idzie w tle. Materiał do testów łączenia
wielu klatek tej samej linii (eksperyment wyżej).

### Kolejność i co jest potrzebne

E7 przed E8: tańsze, usuwa przyczynę, a E8 ma sens dopiero na odczytach, które czasem bywają dobre.
Korpus do porównań: trzy sesje debug plus dwa eksporty nierozpoznanych (`samples/debug/nierozpoznane-*.json`,
`samples/nierozpoznane-*.json`).

Od Ciebie:
- (dostarczone: zrzut z pięcioma kolorami i paleta klienta; do pełnego testu przyda się jeszcze sesja debug
  z kolorowymi wpisami, żeby sprawdzić odciski i dopasowanie klatek, nie tylko maskę);
- (potwierdzone 2026-11-15: obwódka tekstu jest stała, obserwacja linii do zniknięcia z okna).
