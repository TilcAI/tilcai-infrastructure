# N-06 / #32: resultado parcial de investigación TTL

Fecha: 2026-11-01. No se demuestra doble pago ni se modifica el contrato en producción.

Entorno ejecutado: rustc 1.98.1 (48a229cea 2026-09-01), cargo 1.98.1,
soroban-sdk 26.1.0, soroban-env-host 26.1.3, protocolo 26 en Env de testutils;
Cargo.lock existente, sin actualizar dependencias. Base de contrato: 58066a7.

`cargo test --locked --offline -p tilcai-vault` pasó 12 tests, incluidos dos nuevos:

- `payout_reads_do_not_renew_its_ttl`: tras avanzar un ledger, leer payout no renueva
  su TTL; la repetición del mismo ID devuelve AlreadyDisbursed.
- `payout_is_present_on_its_last_live_ledger`: con la instancia disponible, el
  registro con TTL restante 0 todavía rechaza duplicado. El límite se mide en
  ledgers, no se traduce a una garantía de días usando un tiempo de bloque supuesto.

Los diez tests previos incluyen pago de ID nuevo, controles de saldo/cupo y auth.
Las pruebas nuevas no equivalen a una transacción contra Stellar Core ni prueban archivo,
autorestauración o restore explícito. Se dispone de CLI y Docker, pero no había una imagen
Quickstart/ledger local preparada; no se lanzaron nodos ni se usó testnet/mainnet.
No se simula archivo borrando Payout, porque eso inventaría un estado distinto.

## Evidencia de protocolo y conclusión

Persistent expira hacia estado archivado recuperable, mientras Temporary se elimina.
[CAP-0046-12 oficial](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-12.md).
CAP-0066 describe restauración automática de claves archivadas declaradas antes de ejecutar
la función del host; deben comprobarse versión de protocolo y recursos de la transacción.
[CAP-0066 oficial](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0066.md).
Por ello, la ausencia de renovación en `touch` no prueba por sí sola pérdida del antirreplay.

**D-05 propuesta, no aprobada:** no prometer una ventana numérica ni afirmar replay
hasta completar archivo/restauración en ledger local. Mantener backend durable, ID estable
y conciliación; definir renovación y alertas según medición, coste y responsables.
Revisan JHAMILCALI y joseemen11; producto acepta horizonte operativo.

## Protocolo pendiente de integración local

1. Preparar Quickstart estrictamente local con imagen/digest y versiones Core/RPC/protocolo
   registrados; bloquear endpoints de redes públicas. Referencia:
   [Quickstart oficial](https://github.com/stellar/quickstart).
2. Compilar WASM fijando toolchain/lockfile; guardar hash del binario. Crear token y fondos
   sintéticos, auth válida, límites suficientes e IDs de control.
3. Registrar ledger, liveUntil de Payout/instancia/código/token/contador diario y saldos.
   Mantener dependencias vivas sin renovar Payout. Preparar configuración local de TTL
   reducido/avance controlado, guardando el procedimiento y los cambios de configuración.
4. Repetir ID antes, en último ledger vivo y primer ledger vencido. Capturar simulación,
   footprint, error/resultado y balances, con cliente nuevo. No interpretar error de
   token o instancia expirada como prueba de protección de Payout.
5. Probar restauración explícita y, si protocolo aplica, automática: comprobar contenido
   restaurado, coste, receptor/importe, rechazo del ID repetido y éxito de ID nuevo.
6. Repetir tras reinicio de cliente y nodo. Entregar matriz y artefactos. Si se confirma
   necesidad de cambio on-chain, abrir propuesta separada con migración y revisión.

#32 permanece abierta: faltan estos resultados y la aceptación de D-05. Los resultados
SDK permiten acotar el experimento, no cerrar la investigación completa.
