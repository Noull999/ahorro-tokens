@echo off
rem Retoma la conversacion de esta carpeta usando OmniRoute (modelos gratis), solo en esta ventana.
rem No cambia ninguna variable global: se pierde al cerrar la terminal.
rem Uso:  omniroute-claude [modelo]      (por defecto gemini-3.1-flash-lite)
rem Antes: OmniRoute debe estar corriendo en 127.0.0.1:20128.
setlocal
set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=gemini-3.1-flash-lite"
set "ANTHROPIC_BASE_URL=http://127.0.0.1:20128"
set "ANTHROPIC_AUTH_TOKEN=omniroute-local"
set "ANTHROPIC_MODEL=%MODEL%"
set "ANTHROPIC_SMALL_FAST_MODEL=%MODEL%"
rem --continue reabre la ultima conversacion de esta carpeta, completa; si no hay ninguna, empieza una nueva.
claude --continue
if errorlevel 1 (
  if exist ".claude\ahorro-contexto.md" (
    claude "Lee .claude/ahorro-contexto.md: es el contexto de la sesion anterior, que se quedo sin limite. Continua la tarea desde ahi."
  ) else (
    claude
  )
)
endlocal
