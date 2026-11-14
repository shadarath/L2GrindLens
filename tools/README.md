# tools

Narzędzia deweloperskie do analizy próbek z trybu debug. Nie są częścią strony: przeglądarka pobiera tylko
pliki, do których odwołuje się `index.html`, więc nic z tego folderu nie trafia do użytkownika.

Wymagania: Python 3 oraz `python -m pip install --user pillow numpy`.

- `ocr_fingerprint.py <folder sesji debug> [--vis] [--threshold 0.25]`: maska tekstu, segmentacja linii,
  odciski i dopasowanie kolejnych klatek. Pokazuje, ile nowych linii naprawdę pojawiło się między próbkami,
  i zestawia to z liczbą zdarzeń wygenerowanych przez stronę. Z `--vis` zapisuje obrazki masek i nałożeń
  do podfolderu `analysis/` w sesji.
