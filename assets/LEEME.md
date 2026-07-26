# assets/

Aquí van dos archivos que **pones tú**. Están en `.gitignore` a propósito: no se suben
al repo (peso y derechos de autor).

| Archivo | Para qué | Si falta |
|---|---|---|
| `meme.jpg` | La imagen que aparece entre caso y caso, 2,2 s. Entra en `contain` sobre fondo negro, no se deforma. Cualquier proporción sirve; vertical se ve mejor. | Ese tramo sale en negro y el render avisa. |
| `musica.mp3` | Pista de fondo. Se mezcla a −18 dB y se agacha sola cuando suenan los efectos. Se repite si es más corta que el vídeo. | El short sale solo con efectos. |

Rutas alternativas: `npm run render -- --meme otra.png --music otra.mp3`
