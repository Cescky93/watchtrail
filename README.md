# WatchTrail

Mini PWA personale per salvare il backup TV Time, continuare a tracciare serie/anime/film e produrre export recuperabili per Refract o altri servizi.

## Uso immediato
Apri `index.html` con il browser e importa ZIP/JSON/CSV TV Time.

## Uso come app installabile
Pubblica questa cartella su GitHub Pages. Apri l'URL HTTPS da Android/iOS e usa "Aggiungi alla schermata Home" / "Installa app".

## Note
- I dati restano nel browser tramite IndexedDB.
- La ricerca serie usa TVmaze.
- La ricerca anime usa Jikan.
- La ricerca film usa TMDB e richiede una API key gratuita.
- L'import ZIP funziona nei browser che supportano `DecompressionStream('deflate-raw')`; in caso contrario estrai lo ZIP e importa direttamente JSON/CSV.
