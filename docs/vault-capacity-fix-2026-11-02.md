# #35: coherencia de snapshot y replay concurrente

La revisión de `58b6906` encontró dos intercalados que no cubría la reserva original.
Esta corrección mantiene BEGIN IMMEDIATE y añade una barrera durable de liberaciones.

## Cambios

- `SqliteVaultRepository.capacityRevision(network, vault)` obtiene el último seq de evento
  de transición a CONFIRMED/FAILED para esa red/vault. Usa lectura SQLite BigInt y el
  historial durable existente; no depende del reloj ni requiere migración.
- `create` captura ese token ANTES de consultar saldo/cupo por RPC. Dentro de la transacción
  de inserción lo compara de nuevo. Una liberación posterior invalida el snapshot y responde
  SERVICE_UNAVAILABLE: el cliente puede repetir la admisión con datos nuevos. No se envía
  payout ni se reserva con ese snapshot. La comparación y la suma de pendientes están bajo
  el mismo lock de escritura que el insert.
- `insert` resuelve una clave ya admitida antes de ejecutar el callback de admisión y
  devuelve el registro existente. El servicio verifica requestHash y responde replayed=true
  o IDEMPOTENCY_CONFLICT. Todas las guardas de preflight de capacidad/estado se ejecutan
  después de esta resolución, dentro del callback, para no rechazar un replay por BUDGET,
  PAUSED o snapshot obsoleto. Si la lectura RPC falla se vuelve a consultar la clave.
- La emisión de rechazos al monitor ocurre después del rollback de admisión. Se probó con
  MonitorService y SqliteMonitorRepository reales compartiendo conexión: el evento BUDGET
  sigue disponible tras cerrar/reabrir SQLite, sin persistir una reserva rechazada.
- Se preservan antigüedad máxima de 30 segundos, política de día UTC, límites del contrato,
  rollback conjunto insert/evento y retención de reservas inciertas.

## Pruebas

Las sondas de la revisión se trasladaron de `test/review/vault-issues.test.ts` a
`test/unit/vault-issues-regressions.test.ts` y ahora esperan el comportamiento corregido.
Por ello entran en npm test; no son pruebas que pasan al detectar el defecto.

Se comprueban dos conexiones y snapshot anterior a una confirmación; mismo ID concurrente;
replay con referencia; payload distinto; RPC fallido después de otra admisión; replay después
de confirmar; token durable tras reapertura y aislamiento de redes. Las pruebas existentes
con barrera ahora se ejecutan tanto con saldo como con cupo diario suficientes para una sola
reserva. También permanecen las cuatro pruebas de evidencia #28 tras reapertura SQLite.

Validación a fecha de esta ejecución: 215/215 TypeScript, typecheck correcto, 5/5 Python y
12/12 Rust Vault. La investigación #32 y sus artefactos se documentan por separado.

## Límites y operación

Esta barrera detecta liberaciones efectuadas mediante las transiciones del servicio, que
persisten estado y evento en una misma transacción. Las modificaciones manuales del SQLite
por fuera del repositorio/servicio no forman parte del contrato de operación.
El snapshot sigue sin constituir una transacción con la cadena: retiros externos, reorganizaciones
y RPC incoherentes pueden invalidar el saldo observado. El contrato conserva su autoridad.
Un pago ya observado on-chain pero pendiente local puede descontarse dos veces de forma
conservadora. No se alteró esa política ni se introdujeron reenvíos por falta de evidencia.

Rollback de aplicación: no hay cambio de esquema. Volver al código anterior reintroduce las
carreras; se conservan registros, IDs, reservas e historial. Las decisiones operativas y las
revisiones requeridas por #35 siguen correspondiendo a los responsables de la issue.
