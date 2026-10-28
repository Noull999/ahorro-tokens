# ahorro-tokens

Mod para Claude Code (app de escritorio y terminal) que te ayuda a gastar menos: baja el esfuerzo de razonamiento cuando no hace falta, te avisa cuando te acercas a un límite y, si quieres, te deja seguir trabajando con modelos gratis.

## Qué hace (resumen)

| Función | Qué ves |
| --- | --- |
| Ahorro de esfuerzo | Baja el esfuerzo según el prompt y el paso. Nunca lo sube. |
| Mascota y nube | Una mascota sobre la barra de escritura que reacciona a lo que hace Claude y sugiere cambiar de modelo o compactar. |
| Barras de uso | Contexto usado y límite de 5 h / semanal, con aviso al acercarte. |
| Tope de uso extra | Una barra de tu gasto extra contra el tope que fijes (`/ahorro extra 40 1.75`). |
| Salto a modelos gratis | Al llegar al 90-95 % de un límite ofrece seguir con OmniRoute. |
| Ideas | Cada 4 turnos puede sugerir un pendiente o mejora (se apaga con `/ahorro ideas off`). |

## Instalación

```
/plugin marketplace add Noull999/ahorro-tokens
/plugin install ahorro-tokens@ahorro-tokens
```

Reinicia la sesión después de instalar. Todo lo de abajo funciona sin nada más, **excepto** el salto a modelos gratis.

## Qué necesita cada cosa

- **Ahorro de esfuerzo, mascota, barras, ideas:** nada extra. Las ideas y el plan B de compactar usan Haiku (unos pocos tokens).
- **Salto a modelos gratis (OmniRoute):** necesita OmniRoute corriendo en tu computador, en `127.0.0.1:20128`, con un proveedor gratis conectado (por ejemplo Gemini u OpenRouter con modelos `:free`). Sin eso, la oferta del mod no te sirve.
  - Al aceptar, abre una terminal aparte con `omniroute-claude.cmd` (Windows), que ejecuta `claude --continue` con las variables de OmniRoute **solo en esa ventana**. No cambia `ANTHROPIC_BASE_URL` ni ninguna variable global.
  - Si no hay conversación que retomar, usa `.claude/ahorro-contexto.md` del proyecto.
  - Modelo por defecto: `gemini-3.1-flash-lite`; puedes pasar otro: `omniroute-claude otro-modelo`.
- **Tope de uso extra:** Claude Code no entrega ese dato al mod, así que el gasto es una **estimación a precio de API**, no tu factura. Copia tus cifras de la página de plan: `/ahorro extra <tope> [usado]`. Vuelve a escribirlo si se desvía.
- **Windows:** el script de OmniRoute es `.cmd`. En otros sistemas hay que escribir el equivalente.

## Ahorro de esfuerzo

Ajusta el esfuerzo de razonamiento (y, si quieres, el modelo) en cada petición al modelo según lo que se está haciendo, para gastar menos tokens.

- **Por prompt**: clasifica lo que escribes. Diseñar, depurar o refactorizar → `high`. Preguntas cortas, explicar, ejecutar o renombrar → `low`. El resto → `medium`.
- **Por paso**: si el paso anterior solo leyó (Read, Grep, Glob, búsquedas web), el siguiente usa un nivel menos.
- **Subagentes**: siempre `low`.
- **Nunca sube** el esfuerzo por encima del que tienes configurado; solo lo baja.
- **Cambio de modelo** (apagado por defecto): con `/ahorro modelo on`, los subagentes usan Haiku y los prompts simples usan Sonnet, pero esto último solo mientras la conversación tiene menos de 30k tokens. Medido en una sesión real: cada cambio reescribe todo el contexto en la caché del otro modelo (2× el precio de entrada), y con contextos grandes eso cuesta más de lo que Sonnet ahorra en la salida.

Comandos: `/ahorro` (estado), `/ahorro on|off`, `/ahorro modelo on|off`, `/ahorro avatar on|off`, `/ahorro ideas on|off`, `/ahorro idea` (pide una idea ya), `/ahorro cambiar` o `/ahorro no` (responde a una sugerencia de modelo), `/ahorro prueba` (muestra la nube). La línea de estado muestra el esfuerzo y el modelo reales, por ejemplo `esfuerzo low · sonnet-5-5`.

## Avatar y sugerencia de modelo

En el app de escritorio, la mascota pixel de Claude Code vive sobre la barra de escritura y se anima según lo que hace Claude (pensar, leer, escribir, ejecutar, web, delegar, listo, error); en la terminal es una carita de texto. Cuando tiene algo que decir, habla en una nube pixel art. Si el app muestra un aviso propio en esa barra (por ejemplo el de límite de uso), la mascota le cede el sitio hasta que lo cierres. Sugiere cambiar de modelo así:

- **Al terminar un plan** (un turno que no editó archivos, investigó o propuso pasos, y acabó preguntándote algo), en Opus/Fable: "Plan listo. Si lo apruebas, ¿lo ejecuto con Sonnet?". Es el mejor momento para cambiar: se compacta, el plan queda en la entrega y Sonnet ejecuta con un contexto pequeño.
- Tu aprobación corta después de un plan ("sí", "dale", "hazlo", "implementa"…) cuenta como ejecución (`low`), no como tarea difícil.
- **En Sonnet/Haiku, si un turno tuvo 3 o más errores**: "¿Paso a Opus para resolverlo?".
- En Opus/Fable, tras 2 tareas sencillas seguidas: "¿Cambio a Sonnet para gastar menos?"
- En Sonnet/Haiku, ante una tarea compleja: "¿Cambio a Opus para hacerlo mejor?"

**Sí** compacta la conversación con el mismo `/compact` que usas a mano, pidiendo una entrega corta (máximo 300 palabras: objetivo, dónde quedó, siguiente paso, lo ya decidido, archivos clave), y después cambia el modelo con `/model`. El nuevo modelo sigue desde ese resumen, no desde toda la conversación. Una copia queda en `.claude/ahorro-contexto.md` del proyecto.

**Plan B**, si `/compact` no funciona: Haiku lee los últimos 40 mensajes y escribe la misma entrega (cuesta menos de un centavo), se limpia la conversación con `/clear`, se cambia el modelo y la entrega queda escrita en la barra para que la envíes con Enter. El historial anterior sigue guardado en disco.

**No** oculta la nube y no vuelve a sugerir durante 5 prompts.

`/ahorro` muestra cómo terminó el último cambio (plan A, plan B o el motivo del fallo).

## Ideas de la sesión

Cada 4 turnos, Haiku lee los últimos 12 mensajes y, si ve algo útil (un pendiente, una fecha o tarea mencionada, una mejora obvia), lo dice en la nube. **Usar idea** la pone en la barra de escritura para que la envíes o la edites; **Gracias** la cierra. Si no hay nada útil, no dice nada. Cuesta unos pocos tokens de Haiku por consulta; apágalo con `/ahorro ideas off`.
