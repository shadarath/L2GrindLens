# L2GrindLens

Narzędzie do zbierania i analizy zdarzeń z gry Lineage 2 (obrażenia, exp, łupy) przez OCR okna czatu
systemowego. Jeden plik HTML otwierany w Chrome lub Edge, bez instalacji. Nie dotyka procesu gry ani jej
plików: czyta tylko obraz okna udostępniony przez standardowe API przeglądarki, jak przy wideorozmowie.

## Szybki start

1. Uruchom grę w oknie lub w trybie borderless, z czatem systemowym w osobnym oknie.
2. Otwórz `index.html` w Chrome lub Edge
3. Krok 1: "Wybierz okno gry" i zaznacz myszą obszar czatu (pełny panel, bez suwaka)
4. Krok 2: dobierz próg i powiększenie, aż podgląd pokaże czysty tekst, i kliknij Start.

Zdarzenia zapisują się w przeglądarce i można je wyeksportować do SQLite, JSONL lub CSV.
