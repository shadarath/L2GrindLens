# Plan: pasek linii czasu z wyborem zakresu

Stan (2026-11-16): wdrożone w `js/timeline.js` (pasek, ramka, tryby), `js/dashboard.js` (kubełki, znaczniki,
zakres wykresów, panel "Zaznaczenie"), szablonie `#dashTpl` i `css/app.css`. Decyzje: prawa krawędź przy końcu =
podążanie; łupy i dziennik nie filtrują po ramce; znacznik = łup o wartości co najmniej trzykrotności mediany
wartości łupów (`MARK_MULT`). Test w przeglądarce na syntetycznej sesji 90 min: przeciągnięcie prawego uchwytu
daje tryb fixed i panel "Zaznaczenie", przesunięcie ramki do prawej krawędzi daje tryb tail, nowe zdarzenie
przesuwa ramkę tail z zachowaniem szerokości, "cały zakres" wraca do all, wykresy pokazują tylko zakres ramki.

## 1. Co ma powstać

Pod panelami statystyk wąski pasek (canvas, cała szerokość, ok. 56 px wysokości) z:

- uproszczonym przebiegiem XP na minutę i zysku na minutę z całej sesji (dwie linie w stonowanych kolorach,
  każda normalizowana do własnego maksimum; ok. 300 kubełków czasu, nie pełne punkty wykresów);
- znacznikami ważnych momentów: na start przedmiot o wartości powyżej średniej wartości łupu w sesji
  (trójkąt nad paskiem, po najechaniu nazwa i wartość); lista znaczników ma być łatwa do rozszerzenia
  (awans poziomu, śmierć, drogi łup drużyny);
- ruchomą ramką zakresu: uchwyt lewy zmienia początek, prawy koniec, środek przesuwa oba o tyle samo;
  obszar poza ramką przyciemniony; nad paskiem tekst "12:40 – 13:05 (25 min)" i przycisk "cały zakres"
  widoczny tylko, gdy ramka nie obejmuje całości.

Zakres działa na:

- wykresy (oś czasu od początku do końca ramki; średnie kroczące nadal liczą się z próbek sprzed początku
  ramki, więc pierwszy punkt nie startuje od zera);
- statystyki: gdy ramka nie obejmuje całości, pojawia się czwarty panel "Zaznaczenie" z tymi samymi sześcioma
  wartościami (średnie na godzinę z długości zaznaczenia); jako pierwszy od lewej, z wyróżnioną ramką.

Nie działa na tabelę łupów, dziennik i panel nierozpoznanych (do decyzji; łatwo dołożyć później, bo wszystko
liczy się z jednej listy zdarzeń).

## 2. Zachowanie na żywo

Tryb ramki wynika z położenia krawędzi w chwili puszczenia uchwytu (krawędź "przylega", gdy jest w zasięgu
3 px od końca paska):

| krawędzie | tryb | przy nowych zdarzeniach |
|---|---|---|
| obie na końcach | `all` | ramka rośnie z sesją (stan domyślny) |
| prawa na końcu, lewa nie | `tail` | ramka zachowuje szerokość i podąża za najnowszymi zdarzeniami |
| żadna na końcu | `fixed` | ramka stoi w miejscu |

(W prośbie było "lewa krawędź przylega do samego końca"; rozumiem to jako prawą krawędź przy najnowszym
czasie, bo tylko to ma sens dla "podążania za najnowszymi". Do potwierdzenia.)

Koniec paska w trakcie nasłuchu to "teraz", w historii czas ostatniego zdarzenia (tak jak dziś na wykresach).
Ramka nie jest zapamiętywana między przeładowaniami ani między sesjami: nowa sesja startuje w trybie `all`.
Minimalna szerokość ramki 1 minuta.

## 3. Jak to wpiąć w obecny kod

Dashboard przelicza wszystko od zera z `view.events` co 1.5 s (`render` w `js/dashboard.js`). Zmiany:

- `js/timeline.js` (nowy, ok. 200 linii): stan `{ from, to, mode }`, rysowanie paska z gotowych kubełków
  i znaczników, obsługa wskaźnika (`pointerdown/move/up` z `setPointerCapture`, jak zaznaczanie obszaru czatu
  w `capture.js`; uchwyty o szerokości 12 px, żeby dało się złapać palcem), wywołanie zwrotne przy zmianie
  zakresu, metoda `advance(end)` stosująca tryb przy nowym końcu.
- `render`: próbki (`samples`), znaczniki czasu trafień, krytyków i zabójstw liczone są już dla całej sesji;
  dochodzi: kubełki dla paska i lista znaczników (łup o wartości powyżej średniej), potem `timeline.advance(end)`,
  a dalej wykresy i panel "Zaznaczenie" liczone dla `[from, to]`. Liczenie okresów (`PERIODS`) dostaje górną
  granicę `to` zamiast stałego `end`.
- Przeciąganie nie czeka na render co 1.5 s: zmiana ramki odświeża same wykresy od razu (z ograniczeniem do
  jednego odświeżenia na ok. 60 ms), statystyki i panel "Zaznaczenie" po puszczeniu uchwytu.
- Szablon `#dashTpl`: pasek i jego nagłówek między panelami okresów a wykresami; obie instancje (sesja bieżąca
  i historia) dostają własny pasek.
- `css/app.css`: pasek, uchwyty, przyciemnienie, panel "Zaznaczenie".

Koszt: przeliczenie kubełków to jedno przejście po próbkach, przy tysiącach zdarzeń pomijalne; odświeżenie
czterech wykresów Chart.js z ok. 600 punktów trwa kilkanaście milisekund, więc przeciąganie będzie płynne.

## 4. Ryzyka i ocena

- **Zderzenie z renderem co 1.5 s.** Ramka w trybie `fixed` zatrzymuje wykresy w miejscu, to zamierzone.
  Ramka w trybie `all` zachowuje się jak dziś. Jedyna pułapka: render w trakcie przeciągania nie może nadpisać
  ramki, więc stan ramki należy wyłącznie do paska, a render tylko go czyta i wywołuje `advance`.
- **Dwa źródła prawdy dla okresów.** Panele "ostatnia godzina" i "ostatnie 10 min" liczą się od końca sesji,
  nie od końca ramki. Zostaje tak, inaczej ramka zmieniałaby znaczenie tych paneli.
- **Krótkie sesje i historia.** Sesja krótsza niż minuta daje zdegenerowany pasek; wykresy już dziś wymuszają
  minimalną rozpiętość 60 s i pasek dostanie tę samą regułę. W historii pasek działa tak samo, tylko bez
  trybów podążania.
- **Znaczniki.** "Powyżej średniej wartości łupu" przy łupach zdominowanych przez Adenę (dużo małych kwot)
  oznaczy prawie każdy przedmiot z ceną; w praktyce to chyba dobrze (przedmioty z bazy są rzadsze niż Adena),
  ale próg warto mieć w jednym miejscu, żeby go zmienić na np. trzykrotność mediany.
- **Rozmiar wykresów.** Zawężenie zakresu zwiększa gęstość punktów (krok osi 10 s dla krótkich zakresów), więc
  wykresy w wąskim zakresie pokażą więcej szczegółu niż dziś; krok liczy się z długości zakresu, jak dziś
  z długości sesji.
- **Dotyk i klawiatura.** Uchwyty działają na dotyk przez zdarzenia wskaźnika; obsługa klawiatury (strzałki
  przesuwają ramkę) jest do zrobienia osobno, nie blokuje.
- **Bez regresji dla reszty.** Łupy, dziennik, nierozpoznane, eksporty i OCR nie zmieniają się.

Ocena: zmiana średnia, bez wpływu na potok OCR i zapis danych; cała logika mieści się w jednym nowym module
i kilkunastu liniach w `render`. Największy koszt to dopracowanie interakcji (uchwyty, przyciemnienie, podpowiedzi
znaczników). Nie widzę powodu, by powodowała nadmierne problemy.

## 5. Pytania do decyzji

1. Czy "lewa krawędź przy końcu" to w istocie prawa krawędź przy najnowszym czasie (patrz tabela trybów)?
2. Czy tabela łupów i dziennik mają też filtrować po ramce? (Proponuję: na razie nie.)
3. Próg znacznika: średnia wartości łupów czy np. trzykrotność mediany? (Proponuję zacząć od średniej, jak
   w prośbie, z progiem w jednym miejscu.)
