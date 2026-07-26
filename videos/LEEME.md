# videos/

Renders ya hechos, versionados aquí para poder descargarlos desde el celular sin
tener que correr el pipeline. Se regeneran con `npm run render`.

| Archivo | Contenido | Duración |
|---|---|---|
| `casos_icfes.mp4` | Los tres casos seguidos | 49,20 s |
| `caso1.mp4` | Caso 1 · El resumen de última hora | 18,03 s |
| `caso2.mp4` | Caso 2 · Modo avión | 12,80 s |
| `caso3.mp4` | Caso 3 · Confía, mano | 14,37 s |

Todos: **1080×1920 · 30 fps · H.264 High (yuv420p) · AAC-LC 48 kHz estéreo**,
`moov` al inicio (`+faststart`).

Están renderizados **sin** `assets/meme.jpg` ni `assets/musica.mp3`, así que los
tramos entre casos salen en negro y solo se oyen los efectos. Pon esos dos
archivos y vuelve a correr `npm run render` para la versión definitiva.

## Descargarlos desde el celular

En GitHub, abre el archivo → botón **Download raw file**. El navegador lo guarda
y el reproductor del sistema lo abre normal.
