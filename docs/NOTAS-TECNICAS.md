# Lyrics Overlay

Letras sincronizadas flotando sobre tu pantalla mientras suena música en Spotify, YouTube, YouTube Music, Apple Music, Deezer, Tidal, etc. **Solo Windows 10/11.**

## Instalar y ejecutar
1. Instala Node.js LTS (https://nodejs.org).
2. Atajo: doble clic en `Iniciar.bat` (instala y arranca). O a mano, en una terminal en esta carpeta:
   ```
   npm install
   npm start
   ```
3. Se abre la ventana de **Ajustes** y aparece un icono en la bandeja del sistema. Pulsa **"Probar con letra de ejemplo"** para ver el efecto sin música.

Para generar un .exe portable: `npm run dist` (el resultado queda en `dist/`).

## Uso
- Posición: cuadrícula 3×3 (izquierda/centro/derecha × arriba/medio/abajo) + márgenes.
- Texto, colores, brillo, sombra, relleno karaoke, línea flotante, suavidad de animación, monitor y número de líneas.
- **Adelantar/atrasar**: si las letras van un poco desfasadas, corrígelas aquí.
- **Sincronía por canción**: `Ctrl+Alt+→` adelanta las letras 250 ms, `Ctrl+Alt+←` las atrasa y `Ctrl+Alt+↓` quita el ajuste y **`Ctrl+Alt+↑` lo calcula solo**: púlsalo justo en el instante en que oyes empezar una línea y la app fija el ajuste exacto (compensa ~0,18 s de reacción humana). Se recuerda para esa canción (también se ve y se cambia en la tarjeta "Sincronía de esta canción").
- `Ctrl+Alt+L` muestra/oculta las letras. Cerrar la ventana de ajustes no cierra la app: sale desde la bandeja.

## Cómo funciona
- `src/media/get-media.ps1` lee la sesión multimedia de Windows (la misma que usa el control de volumen) y devuelve título, artista y posición.
- `src/lyrics.js` busca la letra sincronizada (.lrc) en LRCLIB (https://lrclib.net), la guarda en caché local y la parsea.
- `src/overlay/` es una ventana transparente, siempre encima y que deja pasar los clics.

## Si algo falla
- **No detecta la canción**: en PowerShell ejecuta `powershell -File src\media\get-media.ps1`, pon música y mira si salen líneas JSON con título y artista.
- **No sale letra**: no todas las canciones están en LRCLIB. YouTube con títulos raros ("Artista - Canción (Video Oficial HD)") puede fallar.
- **Desfase constante**: usa los atajos de sincronía por canción, o el control global "Adelantar/atrasar" (valor de partida en `src/settings.js`, `syncOffsetMs`). Spotify de escritorio a veces reporta la posición con retraso.
- **No se ve en un juego**: los juegos en pantalla completa exclusiva tapan cualquier overlay; usa "pantalla completa sin bordes".

## Cómo se calcula el relleno
- Cada palabra pesa según sus sílabas, y las comas, puntos y signos añaden una pausa (coma ≈ 1 sílaba, punto ≈ 2).
- La velocidad de la canción se estima con la mediana de sus propias líneas, y el relleno de cada línea nunca pasa del hueco hasta la siguiente.
- Si la letra trae tiempos por palabra (LRC "enhanced") se usan tal cual, y si trae la etiqueta `[offset:]` se respeta.
- La posición se mide en el momento exacto de la lectura en PowerShell (cada ~0,3 s) y se extrapola entre lecturas.

## Estabilidad y diagnóstico (v. reciente)
- La posición ya no se cuenta doble cuando Windows entrega una marca de tiempo atrasada (síntoma: letras adelantadas, p. ej. 30 s antes de tiempo).
- Un cambio de canción necesita 2 lecturas seguidas; quedarse "sin canción" necesita ~3 s. Errores puntuales de lectura se ignoran.
- Si PowerShell deja de responder 6 s, se reinicia solo.
- En YouTube la letra se acepta si su duración difiere ≤25 s del vídeo; si no, se avisa de "otra versión".
- Ajustes → "Diagnóstico" muestra modo de posición, duraciones y primera palabra de la letra.

- `Ctrl+Alt+RePág`: la letra va desfasada muchos segundos (versión con otra intro). Púlsalo justo cuando oigas cantar la **primera línea** de la letra y se alinea todo; se recuerda para esa canción.
- La pantalla absorbe las correcciones de posición de Windows poco a poco (sin saltos bruscos); solo los saltos grandes (adelantar la canción) son inmediatos.

## Fuente de letras
Ajustes → "Fuente de letras": **YouTube Music primero** (por defecto, letras alineadas con el audio de YouTube Music; servicio no oficial), LRCLIB primero, o solo LRCLIB. Si una fuente falla se usa la otra. El Diagnóstico muestra de cuál salió la letra.

## Precisión (últimos cambios)
- Si una línea se canta de corrido hasta la siguiente, el relleno usa ese hueco real en vez de estimar por sílabas.
- Lectura de Windows cada ~150 ms (antes 300).
- Diagnóstico → "Estabilidad": correcciones de posición, el mayor error, saltos >0,5 s, mayor hueco entre lecturas y reinicios de PowerShell. Sirve para saber si los saltos vienen de la lectura de Windows.

## Karaoke
- El ritmo del relleno se calcula por zonas (±3 líneas), no solo con la media de la canción.
- Ajustes → Efectos: "Relleno: adelanto" (mueve el relleno respecto a la voz) y "Relleno: velocidad".

## Plan B para Spotify de escritorio
Si Windows no registra a Spotify como reproductor, Cantani lee el título de la ventana de Spotify ("Artista - Canción" al sonar). No hay posición real: cuenta el tiempo desde que cambia la canción, así que si adelantas la canción o abres Spotify a mitad de una pista hay que alinear con `Ctrl+Alt+RePág` (primera línea cantada) o con los botones de ±1 s / ±5 s. Si Windows sí ve a Spotify, este plan B no se usa.

## Rendimiento
- La ventana de letras ya no cubre toda la pantalla: tiene solo el tamaño de la zona de letra (ancho máx., líneas visibles, tamaño de letra y márgenes de Ajustes). Mucho menos trabajo para la GPU.
- Valores de fábrica más ligeros (brillo 8, sin desenfoque de líneas lejanas).
- Título/artista se piden a Windows ~1 vez por segundo (la posición sigue cada 200 ms).
- Si la letra está oculta (pausa) no se calcula nada.

## Modo ligero (activado por defecto)
Ajustes → Efectos → "Modo ligero": sin animación continua de la línea activa, sin brillo grande, sin desenfoque ni máscara de desvanecido, y el relleno se actualiza a ~30 fps. Pensado para laptops justas de recursos. Se puede apagar para ver todos los efectos.
