# Plan de resolución de issues de SaulChoque

Fecha: 2026-11-01. Estado: análisis estático y planificación; ninguna issue implementada o cerrada por este documento. Fuente: consulta GitHub `org:tilcai is:issue is:open assignee:saulchoque`, 4 resultados completos.

> Actualización posterior: #28/#35/#42 tienen implementación en la rama fix/saulchoque-vault-soroban-2026-11-01; ver resultados de Vault/Soroban. #32 tiene dos experimentos SDK ejecutados y protocolo pendiente de archivo/restauración real. Las secciones del plan conservan su estado de elaboración para distinguir propuestas de evidencia posterior.

## Base y arquitectura observada

- Infrastructure: rama `feat/qr-providers-fallback`, HEAD `39cc88eeaf3acad9db6a1f52821b8f4394a8095e`; base remota main `58066a73e999abd604577d0bf5b2ea3524e8ac6f`. Hay cambios locales QR/config/deploy/test/historial e imagen que se conservan. Este análisis lee el árbol de trabajo, no atribuye esos cambios a esta tarea.
- Core: `f642c258e6fbad6284bce1d65ba01dd81498a36c`. Node >=22.20, TypeScript ESM, Fastify, SQLite nativo, viem y SDK Stellar. `src/apps/api/server.ts` compone HTTP; `src/apps/worker/loop.ts` ejecuta reconciliación; dominio y puertos separan adaptadores externos.
- Vault: servicio compartido por red, repositorio durable, estados REQUESTED/SUBMITTED/CONFIRMED/FAILED, control optimista de versión y reconciliación por worker. EVM conserva importe por ID y busca eventos; Soroban conserva receptor e importe en almacenamiento persistente.
- `src/db/sqlite.ts`: WAL, busy timeout y helper síncrono `tx` con BEGIN IMMEDIATE. `insert` es atómico con su evento, pero el cálculo de capacidad se hace antes de tomar ese lock.
- Existen módulos de tenants, cuentas, crosschain, qrcollect, qrsimple y monitor. Los recibos y puertos de comercio no constituyen por sí solos facturación SIN. No se encontró implementación SIAT en los módulos inspeccionados.

## Orden de integración

1. N-02 #28 primero en `vault/service.ts` (1–3 días orientativos).
2. N-09 #35 después de #28 (2–4 días, depende de reproducir carrera).
3. N-06 #32 tiene prioridad P1 de investigación y puede investigarse independientemente de los cambios Vault del backend (2–4 días más disponibilidad de entorno local).
4. N-16 #42 independiente de las anteriores y obligatoria antes del siguiente despliegue Soroban (1–3 días).

Estimaciones de las issues, no compromisos de entrega. Trabajar en ramas independientes desde una base acordada; no incluir el trabajo QR local. Coordinar N-10 #36 en service.ts y N-14 #40 en migraciones. No abrir transacciones SQLite durante llamadas RPC.

## N-02 · evidencia completa de payout EVM · #28

[Issue y aceptación completa](https://github.com/TilcAI/tilcai-infrastructure/issues/28).

**Evidencia:** `VaultDisbursementService.confirmFromChain` valida receptor/importe solo si `found` existe; si `findDisbursed` devuelve null, ejecuta CONFIRMED. `ViemVault.findDisbursed` busca ventanas acotadas por SEARCH_SPAN=24000; null puede significar fuera de rango, no ausencia de pago. `stepSubmitted` ya exige evento concordante. `StellarVault.findDisbursed` puede aportar receptor/importe persistentes aunque txHash sea null; conservar ese caso válido. El método real se encuentra en `src/modules/vault/adapters/stellar.ts`.

**Modificaciones propuestas:**

- `vault/service.ts`: exigir evidencia concordante en todas las rutas de recuperación (REQUESTED, relayer pendiente, AlreadyDisbursed y envío fallido). Si mapping es positivo y no hay evidencia suficiente, retener estado no terminal e `uncertain=true`, registrar motivo y volver a consultar; no reenviar ese payout ni liberar reserva.
- `vault/ports.ts` y adaptadores: si se necesita, representar resultado como evidence/missing/unavailable/mismatch. Un error RPC nunca prueba ausencia. Identidad de red y contrato, ID, receptor, importe y política de confirmaciones deben quedar verificables; no basta con comparar importe del mapping.
- `vault/adapters/evm.ts`: búsqueda paginable con cursor persistente o recuperación por receipt conocido, respetando límites RPC y finalización; no convertir búsqueda más larga en condición de certeza. Runbook para RPC archivado/revisión cuando falte evidencia.
- Conservar IDs, versión, intentos y auditoría; documentar cuándo limpiar uncertain al confirmar. No cambiar contrato desplegado para guardar receptor en este PR.

**Validación a implementar:** evento correcto/ausente/otro ID/receptor distinto/importe distinto; mapping cero/positivo; RPC inaccesible; reinicio SQLite; recuperación tardía confirma una vez; nunca segunda llamada disburse por evidencia ausente. Compatibilidad Soroban con evidencia persistente y sin hash. Revisan JHAMILCALI y OmarQV.

## N-09 · reserva de capacidad concurrente · #35

[Issue y aceptación completa](https://github.com/TilcAI/tilcai-infrastructure/issues/35).

**Evidencia:** `create` consulta status/pending y head de manera asíncrona y comprueba cupo antes de `repo.insert`. `pendingAtomic` suma REQUESTED/SUBMITTED. El helper tx protege la inserción, no la lectura anterior. La estructura permite lecturas intercaladas; todavía no se ejecutó reproducción con dos conexiones. Los contratos mantienen sus límites: no se demuestra sobrepago en cadena.

**Plan:**

1. Reproducir con dos conexiones a un archivo SQLite real y barrera de lectura, capacidad para una sola solicitud y dos claves diferentes. Usar dos procesos/worker threads si el driver síncrono impide producir la intercalación en un solo hilo.
2. Obtener snapshot de red fuera de la transacción; proponer `reserveAndInsert` en repositorio que, dentro de BEGIN IMMEDIATE, relea idempotencia, referencia y compromisos por `(network,vault)` y compare antes de insertar payout+evento. Usar helpers sin tx anidada; el `insert` actual ya abre una.
3. Versionar snapshot (bloque/ledger, instante y día UTC) y rechazar o refrescar el que cruce día o sea demasiado antiguo. Elegir umbral y política con revisores. Snapshot externo no se vuelve atómico por usar SQLite: fondos externos y pagos en tránsito pueden variar. Conservar controles on-chain y reconciliación.
4. Mantener aritmética BigInt exacta; evitar SUM de TEXT con conversión flotante. Una reserva incierta se conserva; liberar solo con prueba de fallo definitivo. Evitar restar dos veces un payout ya observado en cadena y todavía pendiente localmente: documentar política conservadora o reconciliar snapshot antes de admisión.
5. Migrar solo si el diseño requiere snapshots/reservas explícitas; coordinar próximo ID con #40. Revertir aplicación sin perder compromisos; respaldo previo, sin borrar filas financieras al hacer rollback.

**Aceptación:** solo una reserva al borde; misma key+hash devuelve misma operación; mismo key distinto hash conflicto; rollback de insert sin fuga; reinicio; busy timeout; cambio UTC; RPC caído y saldo externo reducido; reservas separadas por red; guardas del contrato intactas. Revisan JHAMILCALI y OmarQV. Si no se reproduce carrera, registrar barrera y resultado antes de modificar esquema.

## N-06 · horizonte de replay Soroban · #32

[Issue y aceptación completa](https://github.com/TilcAI/tilcai-infrastructure/issues/32). P1 de investigación; doble pago no demostrado.

**Evidencia:** `contracts/soroban/vault/src/lib.rs`: `disburse` comprueba `persistent().has(Payout(id))`, guarda Payout y extiende TTL de payout y día al máximo al crearlos; `touch` extiende instancia, no todos los payouts. Almacenamiento persistente archivado no debe equipararse a borrado: demostrar el comportamiento efectivo del host y restore.

**Entregable de investigación:** protocolo local con versiones exactas CLI/Rust/SDK/host, lockfile, hash WASM, parámetros de red, ledger inicial, TTL y auth. El toolchain declarado usa stable: fijar versiones reales del experimento. No se ejecutó ledger local en esta tarea.

| Caso | Preparación | Evidencia requerida |
| --- | --- | --- |
| Antes de TTL | Crear payout, repetir ID | Rechazo de duplicado, un solo cambio de saldo |
| Límite TTL | Medir último ledger vivo y siguiente | Resultado host/tx y saldo en ambos |
| Archivado | Expirar registro conservando instancia utilizable | Diferenciar error de archivo, ausencia y duplicado |
| Restore | Restaurar registro y repetir ID | Payout íntegro y resultado de nueva ejecución |
| Renovación | Renovar registro explícitamente | Nuevo TTL y coste local medido |
| Reinicio | Cliente nuevo sin caché | Resultado depende de estado ledger |
| Control | ID nuevo, fondos y límites suficientes | Pago sintético posible; descarta fallo por fondos/cupo |

Separar unit tests soroban-sdk testutils de integración con host/ledger local que modele archivo/restauración real. Medir también TTL del contador diario y de instancia; controlar timestamp, límites y autorización para evitar falsos negativos. Guardar matriz, comandos y saldos antes/después. Comparar renovación preventiva, registro durable alternativo y restricción temporal de IDs; proponer fix separado si corresponde. D-05 debe indicar horizonte garantizable, renovación, costes, alarmas y riesgo residual. JHAMILCALI/joseemen11 revisan; producto acepta garantía. Ningún upgrade implícito.

## N-16 · preflight y recuperación despliegue · #42

[Issue y aceptación completa](https://github.com/TilcAI/tilcai-infrastructure/issues/42).

**Evidencia:** `contracts/soroban/deploy-testnet.sh` ejecuta build y posibles uploads/deploys antes de exigir operador; --only admite valores no reconocidos; `atomic()` interpola entrada en código Python y convierte mediante int, pudiendo truncar.

**Cambios propuestos:** parser que detecte valores faltantes y flags desconocidos, enum accounts/vault y conjunto completo; validar source/owner/operator, red fija testnet, dependencias, importes y coherencia antes de build/upload/deploy. Resolver identidad sin efectos de red y validar formato/checksum según herramienta local. Importes por argv, sintaxis decimal positiva con máximo 7 posiciones, sin exponente ni truncado; usar conversión entera exacta y comprobar rango i128 además de max<=daily. Exigir operador solo si se despliega vault.

Manifest local atómico por paso: red, source público, configuración normalizada, hashes artefactos y direcciones/estado de cada operación. Nunca secretos. Guardar intención antes del envío y resultado después: corte sin respuesta queda UNKNOWN, no autoriza repetir. Reanudación verifica configuración e IDs; si no puede determinar el resultado, aborta con instrucción de reconciliación. No prometer rollback de cadena. Revisar deploy-mainnet.sh por similitud sin extender automáticamente el alcance de #42.

**Aceptación offline:** stub CLI registra invocaciones; faltantes, unknown --only, operador ausente, comillas/payload, más de 7 decimales, cero/negativo, overflow y orden inválido: cero build/upload/deploy. Válidos convierten exactamente. Corte tras primer deploy y durante respuesta: reanudar sin duplicación o detenerse con manifest. Revisan OmarQV/joseemen11.

## Ejecución posterior y cierre

No se ejecutaron tests ni simulaciones financieras al elaborar este plan. Las verificaciones anteriores son trabajo pendiente. Ejecutar regresiones específicas Vault/SQLite y typecheck al implementar; excluir `test/integration/crosschain-e2e.test.ts` y cualquier prueba con endpoints reales. Leer configuración antes de ejecutar suites completas. Cada PR adjunta base SHA, reproducción, cambio, comandos/resultados, riesgos y revisión requerida; abrir PR no cierra issue. Mantener fixes financieros independientes de facturación SIAT.
