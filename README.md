# memes · pipeline de Shorts

Produce un `.mp4` vertical **1080×1920 / 30 fps** desde una página HTML autocontenida,
sin grabar la pantalla, y opcionalmente lo sube a YouTube como Short.

```bash
npm install
npx playwright install chromium     # una sola vez
npm run render                      # -> out/casos_icfes.mp4
npm run publish                     # -> YouTube (pide lo que falte)
```

---

## Qué hay aquí

| Archivo | Qué hace |
|---|---|
| `casos_icfes.html` | La animación. Autocontenida: HTML + CSS + JS en línea, sin dependencias. Se abre directo en el navegador para previsualizar. |
| `timeline.js` | Abre la página en Chromium a 1080×1920 y expone `seek()` a Node. Lo comparten el render de vídeo y el de audio. |
| `render.js` | Cuadro a cuadro → ffmpeg → mp4. Es el comando principal. |
| `audio.js` | Renderiza los efectos offline y los mezcla con la música. |
| `upload.js` | Subida a YouTube con OAuth2. |
| `ffmpeg.js` | Encuentra ffmpeg/ffprobe y da instrucciones si faltan. |
| `config.json` | Valores por defecto de salida y de subida. |
| `assets/` | `meme.jpg` (imagen entre casos) y `musica.mp3` (fondo). **Los pones tú**, no están en el repo. |

---

## Cómo funciona el render (y por qué no graba la pantalla)

Grabar con `getDisplayMedia` + `MediaRecorder` depende de la máquina: salta cuadros,
el audio se desfasa y el resultado cambia en cada corrida.

Aquí la animación **es una función del tiempo**. `casos_icfes.html` construye a partir
del arreglo `CASES` una línea de tiempo declarativa —una lista de eventos con instante,
duración y estado— y expone:

```js
window.__duration()      // duración total en ms
window.__seek(tMs)       // pone el DOM en el estado exacto de ese instante
window.__renderAudio()   // renderiza los efectos con OfflineAudioContext
window.__timeline()      // la línea de tiempo cruda, para depurar
```

No hay ni un `setTimeout` ni un `await sleep` en la animación: cada cuadro se pide por
su instante. Renderizar el cuadro 500 dos veces da exactamente el mismo PNG, y el audio
sale del mismo cronograma, así que queda sincronizado al sample.

El botón `⏺ Grabar pantalla` sigue en la página como respaldo, pero el mp4 bueno sale de
`npm run render`.

### Opciones

```
npm run render -- [opciones]

  --caso N          solo ese caso, con su cortinilla
  --fps N           default 30
  --crf N           calidad H.264, menor = mejor (default 18)
  --out RUTA        default out/casos_icfes.mp4
  --music RUTA      default assets/musica.mp3 si existe
  --meme RUTA       default assets/meme.jpg
  --keep-frames     además guarda los PNG en out/frames/
  --no-audio        vídeo mudo
  --sfx-gain N      dB que se le suben a los efectos (default 10)
  --trim-silence    recorta silencio SOLO al final
```

Atajos: `npm run render:caso1`, `:caso2`, `:caso3`.

### Audio

Los efectos (tecleo, tic-tac del reloj, dings, golpe de cortinilla, apagado) se generan
por código con Web Audio. El **mismo módulo** corre en la vista previa (`AudioContext`) y
en el render (`OfflineAudioContext`), sobre la misma línea de tiempo.

Si existe `assets/musica.mp3` se mezcla por debajo a **−18 dB** con `sidechaincompress`,
así la música se agacha sola cuando suena un efecto. La mezcla se corta al largo exacto
del vídeo (`cuadros / fps`) con un fundido de salida de 300 ms.

**El silencio interno no se toca**: la pausa mientras la IA "piensa" es parte del chiste.

---

## Permisos de Google (el trámite, paso a paso)

**No puedo hacer esto por ti.** La API de YouTube no acepta usuario y contraseña: exige
credenciales OAuth creadas desde tu propia cuenta. Es un trámite de unos 10 minutos y
solo se hace una vez.

1. **Crea el proyecto.** Entra a <https://console.cloud.google.com/>, arriba a la
   izquierda abre el selector de proyectos → **Proyecto nuevo**. Ponle `shorts-icfes` y
   crea.

2. **Habilita la API.** Menú ☰ → **APIs y servicios** → **Biblioteca**. Busca
   `YouTube Data API v3`, ábrela y dale **Habilitar**.

3. **Configura la pantalla de consentimiento.** ☰ → **APIs y servicios** →
   **Pantalla de consentimiento de OAuth**.
   - Tipo de usuario: **Externo** → Crear.
   - Nombre de la app: `shorts-icfes`. Correo de asistencia y de contacto: el tuyo.
   - En **Permisos**, agrega el scope `https://www.googleapis.com/auth/youtube.upload`.
   - En **Usuarios de prueba**, agrega **tu propio correo de Gmail**. Sin esto Google te
     va a rechazar el login.
   - Guarda. Deja la app en estado **Prueba** (no la publiques, no hace falta).

4. **Crea las credenciales.** ☰ → **APIs y servicios** → **Credenciales** →
   **Crear credenciales** → **ID de cliente de OAuth**.
   - Tipo de aplicación: **Aplicación de escritorio**.
   - Nombre: `cli`. Crear.
   - En el diálogo, **Descargar JSON**.

5. **Guárdalo aquí.** Renombra el archivo descargado a `client_secret.json` y déjalo en
   la raíz del proyecto. (O exporta `YT_CLIENT_ID` y `YT_CLIENT_SECRET` en tu `.env`.)
   Está en `.gitignore`; **no lo subas al repo**.

6. **Primera subida.** `npm run publish` abre el navegador, te pide autorizar, y guarda
   `token.json` para no volver a preguntar.

---

## Lo que tienes que saber antes de subir

### 1. Los vídeos van a quedar bloqueados en privado

Esto es real y te va a pasar. Mientras tu proyecto de Google Cloud **no pase la
auditoría de cumplimiento de la API de YouTube**, todo lo que suba la API queda
**bloqueado como privado**, y no lo puedes hacer público ni desde YouTube Studio. Pedir
`privacy: public` no cambia nada: YouTube lo ignora.

**El plan realista:** usa el pipeline para *renderizar* el mp4 automáticamente y **súbelo
tú a mano** desde la app de YouTube o Studio. Es un arrastrar y soltar, y el vídeo sale
público sin trámites. `npm run publish` te sirve para archivar copias privadas o para
cuando pidas la auditoría.

Pedir la auditoría se hace desde la pantalla de consentimiento de OAuth y tarda semanas;
para "algún short suelto, experimentando" —que es tu caso— no vale la pena.

### 2. La cuota diaria te alcanza para 6 subidas

| Concepto | Unidades |
|---|---|
| Cuota diaria por defecto | 10.000 |
| Una subida (`videos.insert`) | 1.600 |
| **Subidas por día** | **6** (9.600 unidades) |

La séptima falla con `quotaExceeded` y se reinicia a medianoche hora del Pacífico. El
script no reintenta ni sube en lote, así que no puede quemarte la cuota solo; pero si
corres `npm run publish` siete veces en un día, la séptima falla. Ampliar la cuota es
otro formulario con revisión manual.

### 3. El token caduca cada 7 días

Con la app en estado **Prueba**, Google invalida el *refresh token* a los 7 días. Cuando
pase, borra `token.json` y vuelve a correr `npm run publish`: te pide autorizar otra vez.

---

## Cosas que hice distinto a lo pedido, y por qué

- **Los cuadros van directo a ffmpeg por una tubería**, no a disco. 1.800 PNG de
  1080×1920 son varios GB por corrida. El resultado es idéntico; si los quieres en disco,
  `--keep-frames`.

- **`silenceremove` está apagado por defecto.** Con `stop_periods=-1` ffmpeg también se
  come los silencios de en medio, y ahí está el chiste. Como el audio se renderiza
  offline con duración conocida, recortar exacto a `cuadros / fps` ya deja cero cola.
  `--trim-silence` sí lo activa, implementado con `areverse → silenceremove → areverse`
  para que toque **solo** el final.

- **`timeline.js` y `audio.js` son módulos de Node, no scripts que cargue el HTML.** La
  página tiene que seguir siendo autocontenida (abrirse con doble clic desde `file://`),
  y un `<script src>` externo rompe eso. El "módulo compartido" de efectos vive dentro de
  la página y lo usan tanto la vista previa como el render offline, que era el punto.

- **`casos_icfes.html` está escrito desde cero en este repo.** No existía aquí; lo
  construí siguiendo tu descripción (lienzo 540×960, celular con marco/cámara/botones,
  `#stage` 464×960, modo zona segura activado, tres casos con cortinilla, los ocho tipos
  de beat, los efectos por código, el grabador de respaldo). Los textos de los tres casos
  son míos. **Si tienes el original, pásamelo**: la línea de tiempo y todo el pipeline
  funcionan igual, solo hay que traer el arreglo `CASES` y el CSS.

- **La subida no está probada de punta a punta.** Necesita tus credenciales de Google y
  yo no las tengo. El render sí está probado y verificado con ffprobe.

---

## Problemas comunes

| Síntoma | Qué hacer |
|---|---|
| `No encontré ffmpeg` | `brew install ffmpeg` / `sudo apt install ffmpeg`, o `npm i ffmpeg-static ffprobe-static` |
| `Executable doesn't exist` (Playwright) | `npx playwright install chromium`, o apunta `CHROMIUM_PATH` a un Chrome ya instalado |
| La imagen entre casos sale en negro | Falta `assets/meme.jpg` |
| El vídeo pasa de 60 s | Acorta los `beats` en `CASES`, o sube caso por caso con `--caso N` |
| `quotaExceeded` | Ya subiste 6 hoy; espera a medianoche (hora del Pacífico) |
