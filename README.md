# L2GrindLens

Narzędzie do zbierania i analizy zdarzeń z gry Lineage 2 (obrażenia, exp, łupy) przez OCR okna czatu
systemowego. Jeden plik HTML otwierany w Chrome lub Edge, bez instalacji. Nie dotyka procesu gry ani jej
plików: czyta tylko obraz okna udostępniony przez standardowe API przeglądarki, jak przy wideorozmowie.

## Szybki start

1. Uruchom grę w oknie lub w trybie borderless, z czatem systemowym w osobnym oknie.
2. Wybierz okno gry i zaznacz myszą obszar czatu (zaznacz pełny panel, bez suwaka)
3. Dobierz próg i powiększenie, aż podgląd pokaże czysty tekst
4. Wpisz swój nick do rozpoznawania któe wpisy są twoje
5. Przejdź do aktualnej sesji i zacznić marnować życie w swój ulubiony sposób, ale tym razem ze statystykami.

Następnym razem wszystkie ustawienia będą zapisane i wystarczy zrobić krok 2.

Zdarzenia zapisują się w przeglądarce i można je wyeksportować do SQLite, JSONL lub CSV.
