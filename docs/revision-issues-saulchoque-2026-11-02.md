# Revisión de #28, #35, #42 y #32

Revisión: 2026-11-02 UTC (1 de noviembre en Bolivia). Usuario GitHub: SaulChoque.
HEAD revisado: `58b6906ff09dd771f6a9acc9b921b2ee87c04be0`.
Rama: `fix/saulchoque-vault-soroban-2026-11-01`.
Se consultaron cuerpos, asignaciones, estado y comentarios de las cuatro issues mediante gh.
Todas están abiertas y asignadas a SaulChoque; no tenían comentarios de revisión.
Se actualizó origin con fetch y se inspeccionó el historial de todas las ramas.
La implementación está en esta rama, commit `73805cc`, también alcanzable desde
`origin/feat/third-party-credentials`. No fue necesario cambiar de rama.

## Resultado por issue

| Issue | Veredicto técnico | Pendiente para cierre |
| --- | --- | --- |
| #28 | Corrección central validada, incluida persistencia tras reapertura | Revisiones independientes y validación operativa de recuperación histórica |
| #35 | Parcial: corrige carrera original, pero quedan dos intercalados defectuosos | Corregir coherencia snapshot/reservas y replay concurrente; revisión |
| #42 | Aceptación automatizada principal validada con CLI falsa | Revisiones independientes y procedimiento operativo aprobado |
| #32 | Investigación incompleta | Archivo, restore, cliente reiniciado en ledger local y decisión D-05 |

## Hallazgos reproducidos

### #35: se libera capacidad frente a un snapshot que todavía incluye el saldo gastado

Ubicación: `src/modules/vault/service.ts:94`, `:154`; `repository.ts:38`.
Prueba: `test/review/vault-issues.test.ts:37`.

1. Dos servicios comparten archivo SQLite mediante dos conexiones. Hay 10 USDC.
2. B captura saldo 10 y se suspende antes de reservar.
3. A admite 10, el fake mina y A confirma. Su reserva deja de contar como pendiente.
4. B continúa dentro de los 30 segundos permitidos y el mismo día UTC.
5. La transacción vuelve a calcular pendientes = 0, pero compara con saldo antiguo = 10.
6. B admite otros 10. Su simulación detecta InsufficientBalance y queda REQUESTED con reserva 10 y saldo real 0.

Esto es sobrepromesa local con snapshot incoherente, sin demostrar sobrepago on-chain.
BEGIN IMMEDIATE protege los escritores locales; no vuelve coherente un saldo leído antes con
una reserva liberada después. El límite de 30 segundos no evita este intercalado.
Recomendación: asociar el snapshot a una generación durable de cambios de capacidad y
rechazar/refrescar cuando haya confirmaciones/liberaciones posteriores, o contabilizar los
compromisos que consumieron ese snapshot. Refrescar sin barrera/versionado deja otra carrera.
No se aplicó una política financiera nueva durante esta revisión.

### #35: misma clave puede recibir BUDGET en vez de replay

Ubicación: `service.ts:83`, `:125`, `:163`.
Prueba: `test/review/vault-issues.test.ts:67`.

Dos peticiones pasan la búsqueda inicial de clave inexistente. Mientras una espera status,
la otra reserva toda la capacidad sin minar. La primera retoma y status incluye esa reserva:
el preflight lanza BUDGET antes de entrar al insert/constraint que resolvería el replay.
No duplica el payout, pero incumple la respuesta idempotente esperada bajo este intercalado.
Recomendación: resolver de nuevo clave/hash en la frontera de admisión antes de rechazar
capacidad; también contemplar el rechazo previo por reference. Añadir prueba de aceptación
que espere mismo ID y replayed=true. La sonda actual afirma el defecto observado.

## Qué modificó la implementación existente

### #28

`service.ts:266`, confirmFromChain, ahora captura fallo de findDisbursed y conserva incertidumbre;
si no hay evidencia hace lo mismo. Receptor e importe deben coincidir para confirmar.
El mapping positivo por sí solo dejó de ser prueba suficiente.
`ViemVault.findDisbursed` filtra por vault y disbursementId; aporta receptor/importe del evento.
Su búsqueda sigue limitada a aproximadamente 24.000 bloques: un evento posterior/fuera de
rango conserva incertidumbre. Es comportamiento previo del adaptador, no una ampliación de esta corrección.
`StellarVault.findDisbursed` obtiene Payout(id), que sí conserva receptor/importe y permite
confirmar sin hash del evento; por eso no se impuso un hash obligatorio a ambas redes.
La política documentada requiere evidencia histórica y coordinación operativa cuando los
logs EVM no sean recuperables; no existe endpoint nuevo de confirmación manual.

Pruebas nuevas de esta revisión cierran/reabren la conexión SQLite y reconstruyen servicio/repositorio
para evidencia ausente, receptor erróneo, importe erróneo y excepción RPC. En cada caso permanecen
ID y reserva, no se hace otro submit, y al restituir evidencia se confirma exactamente una vez.
Es reapertura real del archivo, no kill de proceso ni simulación de fallo eléctrico.

### #35

`repository.ts:34` ejecuta insert y evento dentro de tx, que usa BEGIN IMMEDIATE en `db/sqlite.ts`.
El callback de admisión suma amount_atomic como BigInt filtrando red/vault y estados pendientes,
después de tomar el lock. UNIQUE conserva una ruta de replay para carreras que alcanzan insert.
`service.ts:154` contrasta esos pendientes con el snapshot y rechaza antigüedad >30 segundos o
cruce de día UTC. La implementación no necesita una migración. Los tests originales validan
barrera con dos conexiones, misma clave, reapertura y rollback de evento/insert.
Los hallazgos anteriores limitan el alcance real de esta solución.

### #42

`deploy-testnet.sh` delega a Python. `deploy_testnet.py:19` valida dirección G con versión y CRC;
`:30` convierte un decimal de hasta siete posiciones con enteros y verifica rango positivo i128.
`:39` usa argparse sin abreviaturas, valida source/only/operator/max<=daily y fija red testnet.
Los valores son datos de argv, no código Python interpolado. La identidad se consulta localmente
antes de build/upload/deploy. Un flag de red no soportado se rechaza.
`:65` crea manifest exclusivo. `:87` registra UNKNOWN y persiste antes de cada operación;
al validar respuesta guarda COMPLETED. Se guardan hashes WASM, configuración y resultados.
Un manifest existente impide repetir la ejecución. DEPLOY_RECOVERY.md describe verificación,
adopción o abandono con decisión operativa; no hay reanudación automática.
La CLI falsa prueba entrada hostil, decimales, límites, exactitud, corte parcial y bloqueo del reintento.

### #32

Solo se añadieron dos experimentos SDK en `contracts/soroban/vault/src/test.rs:189`:
lecturas no renuevan TTL y el último ledger vivo todavía rechaza el ID.
No se cambió lib.rs para resolver un replay supuesto. La documentación reconoce expresamente
que testutils no prueba archivo/restauración en Core, ni establece horizonte financiero.
En este entorno hay CLI y Docker, pero las imágenes locales no incluyen un ledger Stellar.
No se preparó ni ejecutó ese experimento completo en esta revisión. No se puede cerrar #32.

## Comandos y resultados de esta revisión

| Comando | Resultado |
| --- | --- |
| npm test | 201/201 |
| npm run typecheck | OK, repetido tras añadir sondas |
| python3 test/unit/deploy-testnet.test.py | 5/5 |
| node_modules/.bin/tsx --test test/review/vault-issues.test.ts | 6/6: cuatro validaciones #28 y dos reproducciones de defectos #35 |
| cargo test --locked -p tilcai-vault (contracts/soroban) | 12/12 |

Primer intento cargo --offline falló por dependencia stellar-accounts ausente del caché.
La ejecución --locked descargó dependencias de compilación y pasó sin cambiar Cargo.lock.
El toolchain stable se sincronizó (no estaba fijado a versión exacta); host rustc/cargo reportaron
1.99.1 tras la ejecución. Esto no demuestra reproducibilidad binaria con la versión 1.98.1 del informe previo.
No se ejecutó npm run test:integration: incluye accesos RPC y operaciones que requieren autorización
separada. No se hicieron pagos, despliegues, llamadas a RPC financiero, Circle ni Relayer reales.

## Cambios hechos durante la revisión

Se añadieron este informe y `test/review/vault-issues.test.ts`, y se actualizó AGENT_HISTORY.md.
Las dos pruebas llamadas reproduces están fuera del glob npm test y pasan cuando el defecto sigue
reproducible: no deben contarse como aceptación funcional de #35. Se ejecutan con comando explícito.
Se conservaron el código de negocio y el pnpm-lock.yaml no rastreado que ya existía.
No se hicieron commits, push, comentarios en GitHub ni cierre de issues.


## Seguimiento posterior a esta revisión

Los dos defectos de #35 se corrigieron después de este informe, con 215 pruebas unitarias
y las reproducciones convertidas en aceptación dentro del glob npm test. Véase
[vault-capacity-fix-2026-11-02.md](vault-capacity-fix-2026-11-02.md).
La investigación técnica #32 se completó con Core/RPC locales y evidencia de archivo,
restore, renovación y reinicio: [soroban-ttl-results-2026-11-02.md](soroban-ttl-results-2026-11-02.md).
El estado original del informe describe HEAD 58b6906 antes de estas modificaciones.
