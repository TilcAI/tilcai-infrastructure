# Cuota de operaciones patrocinadas (N-14 · propuesta D-03)

> **Estado: propuesta pendiente de aprobación** de producto/equipo (D-03), con revisión de Saúl (fondos) y Omar (tenants).
> La implementación aplica la política de abajo; cambiarla es tocar `isSponsoredMode` y los puntos de liberación indicados.

## Qué cuenta como operación patrocinada

Una unidad de `quota_sponsored_ops_per_day` (contador `tenant_usage.kind = 'operation'`, día UTC) **por pago** cuyo *burn de origen* envía el
Relayer de TilcAI.

| Modo | ¿Consume cuota? | Por qué |
|---|---|---|
| `gasless`, `dev_gasless`, `account` | **Sí, 1 por pago** | El Relayer envía y paga el burn (`sendBurnToRelayer`). |
| `external` | **No** | El pagador envía y paga su propio burn. |
| `dev_signer` | **No** | Llave de desarrollo, solo testnet. |
| Mint en Stellar | **No** | Lo paga el Relayer en todos los modos, incluido `external`; la ficha pide `external` = 0. Si producto quiere contarlo, es otra decisión. |

## Cuándo se reserva, consume y libera

La reserva se hace **justo antes de llamar al Relayer**, en una transacción SQLite que cuenta la unidad (una sola sentencia atómica,
`consumeQuotaSql`) y escribe la fila `sponsored_holds` (una por pago: la clave de idempotencia del pago la identifica).
Replays y reintentos del mismo pago reutilizan la reserva: **nunca cobran dos veces**.

| Hold | Entra por | Sale por |
|---|---|---|
| `HELD` | Reserva antes del envío | → `CONSUMED`, → `RELEASED` o se queda |
| `CONSUMED` | El burn salió (pago pasa `AWAITING_BURN → BURN_SUBMITTED`, por el Relayer o por `POST /burn` de un operador) | final |
| `RELEASED` | Relayer **rechazó** el envío (4xx distinto de 408: no se envió nada) · o la autorización venció sin usarse (`FAILED`) | puede volver a `HELD` si el pago reintenta y hay cupo |

| Situación | Resultado |
|---|---|
| Cupo agotado o tenant suspendido | No se llama al Relayer; el pago queda `AWAITING_BURN` con `lastError = SPONSORED_QUOTA_EXHAUSTED` y el worker reintenta con backoff hasta que haya cupo o venza la autorización (`FAILED`, `BURN_NOT_EXECUTED`). |
| Rechazo 4xx (≠ 408) | Se libera la unidad y se reintenta. |
| **408, timeout, 5xx, sin respuesta** | **Se conserva el hold**: el Relayer pudo recibir la operación. Se respeta la guardia de reenvío; el reintento usa el mismo hold. |
| Relayer informa tx fallida | El hold se conserva mientras el worker reenvía la misma autorización (una sola unidad por pago). |
| Autorización vencida y no usada | Se libera (ya no puede enviarse). |
| Reinicio | El hold está en SQLite: no se cobra otra vez ni se reenvía dentro de la guardia. |

Aislamiento: el contador y el hold llevan el `tenant_id`; el agotamiento de A no afecta a B.

## Cambios

- Migración **7** (`sponsored_holds`). **El ordinal es provisional**: coordinar con N-09 (#35) antes del merge. Rollback: `DROP TABLE sponsored_holds`
  (los contadores de `tenant_usage` se reinician con el día UTC).
- `SubmissionRejected` lleva el `status` HTTP; el adaptador del Relayer EVM lo pasa. Un 408 ya no se trata como "nada enviado"
  en este camino (antes se borraba `burnRequestedAt` y se reenviaba sin esperar la guardia).
- `CrosschainRepository.reserveSponsored / consumeSponsored / releaseSponsored`.

## Limitaciones conocidas

- Si el proceso muere entre pasar a `BURN_SUBMITTED` y marcar el hold `CONSUMED`, el hold queda `HELD`: la cuenta es la misma (la unidad sigue gastada), solo la etiqueta atrasa.
- La unidad se cobra al reservar, no al crear el pago: un intento que nunca llega al Relayer no consume (decisión de la ficha).
- No cubre compras MCP (H-10) ni cuentas/delegaciones (esas usan su propia cuota o `consumeQuota`).
- Un pago con la cuota agotada no devuelve 429: queda pendiente y visible en `lastError`. Si producto prefiere 429 síncrono, es un cambio en la API.
