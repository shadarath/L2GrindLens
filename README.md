# L2GrindLens

Narzędzie do zbierania i analizy zdarzeń z gry Lineage 2 (obrażenia, exp, łupy) przez OCR okna czatu
systemowego. Jeden plik HTML otwierany w Chrome lub Edge, bez instalacji. Nie dotyka procesu gry ani jej
plików: czyta tylko obraz okna udostępniony przez standardowe API przeglądarki, jak przy wideorozmowie.

## Szybki start

1. Otwórz `ocr/L2GrindLens-OCR.html` w Chrome lub Edge (potrzebne połączenie z internetem, bo silnik OCR
   Tesseract.js i biblioteka wykresów dociągają się z CDN; za pierwszym razem kilkanaście MB, potem z pamięci
   podręcznej przeglądarki).
2. Gra w oknie lub borderless, czat systemowy w osobnym oknie, czcionka czatu powiększona.
3. Strona prowadzi przez trzy kroki:
   - **Źródło obrazu**: "Wybierz okno gry", zaznaczenie obszaru czatu myszą (kilkanaście pikseli na prawo od
     ikon przewijania). Obszar jest pamiętany i wraca przy następnym uruchomieniu.
   - **Obróbka i OCR**: klatki na sekundę, powiększenie, próg; podgląd obróbki odświeża się na żywo, więc próg
     dobiera się patrząc na efekt. Wszystkie ustawienia (także imię postaci i wzorce zapasowe) są pamiętane.
   - **Aktualna sesja**: Start/Stop, kafelki sesji, wykresy obrażeń, XP i SP na minutę (średnia krocząca
     z ostatnich 60 sekund, punkt co 10 sekund), obrażenia wg celu z liczbą zabitych ("Marsh Zombie Lord x17")
     i wg źródła, tabela łupów, dziennik z filtrem. Gra nie ogłasza śmierci potwora, więc zabicie jest liczone
     z komunikatu o XP: każdy trafia do ostatnio bitego celu, jeśli przyszedł w ciągu 15 sekund od trafienia. "Start" w kroku 2 przenosi od razu tutaj i zawsze otwiera
     nową sesję.

   Osobna zakładka **Historia sesji** (po prawej stronie paska) pokazuje ten sam układ dla zapisanych sesji,
   tylko do odczytu: wybór sesji z listy, eksport, usuwanie. Trwająca sesja pojawia się w historii po
   zatrzymaniu; do zakończonej sesji nie da się już dopisać zdarzeń.

"Test na próbce" w kroku 1 sprawdza cały potok na sztucznym czacie bez gry.

## Jak to działa

Co klatkę wycinek czatu jest powiększany i zamieniany na czarny tekst na białym tle. Klatki bez zmian w obrazie
są pomijane. Tekst z OCR jest czyszczony (śmieci z ikon, sklejanie zawiniętych linii, typowe pomyłki OCR), a nowe
linie względem poprzedniej klatki są rozpoznawane z tolerancją na drobne błędy w literach; liczby muszą się
zgadzać co do cyfry. Pojedyncze przekłamania w starych liniach (np. gdy przy ruchu kamery zmienia się tło pod
półprzezroczystym czatem) nie psują dopasowania, a nowa linia jest zgłaszana dopiero, gdy potwierdzi się
w następnej klatce. Jeśli czat w grze ma regulację przezroczystości, nieprzezroczyste tło dodatkowo
stabilizuje OCR. Przy pierwszym Starcie logowane jest wszystko, co widać w czacie. Po Stop i ponownym
Starcie pierwsza klatka jest tylko punktem odniesienia: do nowej sesji trafiają wyłącznie linie, które pojawią
się później. Każda nowa linia jest dopasowywana
do szablonów z bazy komunikatów (`ocr/systemmsg.js`): dostaje numer komunikatu `id` i pola z placeholderów
(obrażenia, cel, źródło, ilość, przedmiot...). Typ zdarzenia (dmg_dealt, dmg_received, exp, item, crit, miss,
block, skill, cooldown, cast_fail, level_up, death...) nadaje tabela `MSG_TYPES` w `ocr/js/messages.js`; komunikaty
spoza niej dostają typ `msg`. Pole "imię postaci" odróżnia Twoje obrażenia od cudzych w komunikatach z imieniem;
cudze dostają typ `dmg_other`. Wzorce zapasowe działają tylko dla linii, które nie pasują do żadnego szablonu.

Wydajność: OCR w WebAssembly zajmuje od kilkuset do ponad tysiąca ms na klatkę zależnie od wielkości obszaru,
więc realne tempo to 1 do 3 klatek na sekundę. Przy bardzo szybkim przewijaniu czatu pojedyncze linie mogą uciec;
pomaga wyższe okno czatu i mniejszy obszar.

## Dane

Zdarzenia każdej sesji zapisują się na bieżąco w IndexedDB przeglądarki i są dostępne po ponownym otwarciu
strony. "Zapisz bazę SQLite" buduje plik `l2grindlens.sqlite` (tabele `events` i `sessions`) ze wszystkich sesji.
Po wskazaniu folderu danych plik SQLite zapisuje się tam bez pytania, a baza odświeża się co minutę w trakcie
sesji i przy zatrzymaniu. JSONL i CSV eksportują oglądaną sesję. Format zdarzenia:

```json
{"session":"2026-11-10T04:00:00.000Z","ts":1794283200000,"time":"...","type":"dmg_dealt",
 "fields":{"id":2261,"src":"Shad","dmg":187,"target":"Balor Orc Lieutenant"},"text":"Shad has inflicted 187 damage on Balor Orc Lieutenant."}
```

## Baza komunikatów: ocr/data

`systemmsg.tsv` to 3236 komunikatów systemowych (id, szablon z `$s1`/`$c1`) wyciągniętych skryptem
`extract_systemmsg.py` z pliku `SystemMessageId.java` emulatora L2J Mobius (High Five). Brzmienie części
komunikatów na konkretnym serwerze różni się od stocku, a pliki klienta bywają zaszyfrowane własnym kluczem
serwera, więc dokładne teksty zbiera się z okna "System Msg" w grze: wpisz słowo w Find, zrób zrzut listy
i przepuść go przez OCR (np. stroną z wczytanym zrzutem, czytając surowy wynik), zapisz jako próbkę `.txt`
w `ocr/samples` w formacie z sekcją "## Surowy wynik OCR", a potem uruchom `extract_samples.py`. Skrypt wyciąga pary id + tekst ze wszystkich próbek,
poprawia pomyłki OCR w placeholderach, zapisuje `systemmsg_reborn.tsv` (ze statusem: taki sam / inny / nowy
względem L2J, poprzednie wpisy zostają) i przebudowuje `ocr/systemmsg.js` jako bazę L2J nadpisaną wpisami
z serwera.

## Struktura kodu

Zwykłe skrypty bez modułów ES, żeby strona działała z dysku. `ocr/js`: `core.js` (ustawienia, status),
`messages.js` (baza komunikatów, typy zdarzeń, wzorce zapasowe), `lines.js` (czyszczenie linii OCR, wykrywanie
nowych), `image.js` (binaryzacja, sygnatura zmian), `storage.js` (IndexedDB), `capture.js` (źródło obrazu,
podgląd, obszar), `ocr.js` (Tesseract, pętla, sesje), `dashboard.js` (kafelki, wykresy,
dziennik), `files.js` (folder danych, SQLite, eksport), `app.js` (zakładki i spięcie całości). Style
w `ocr/css/app.css`.
