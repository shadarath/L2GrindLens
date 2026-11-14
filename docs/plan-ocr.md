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

### E4. Pewność, potwierdzanie i lista "nieznane"

- Pewność z Tesseracta na poziomie słów; linia o niskiej pewności czeka na drugi, zgodny odczyt (dziś czeka
  tylko na obecność w następnej klatce).
- Zdarzenie powstaje dopiero, gdy: odcisk linii jest nowy (E1), szablon dopasowany powyżej progu (E3), pola
  skanonizowane powyżej progu (E3) i barwa linii zgadza się z typem (E2). Każdy brak to `unknown`.
- Panel "nierozpoznane" w sesji: surowy tekst, miniatura linii, powód odrzucenia. Z niego rosną słowniki
  i poprawki, zamiast z domysłów.

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
