# #32 / N-06: archivo, restauración y horizonte antirreplay

## Resultado técnico

Se ejecutó la matriz de investigación contra un **Stellar Core real y RPC locales**, con
WASM del Vault sin modificar, autorización válida y fondos sintéticos. No se reprodujo un
payout duplicado. El vencimiento de Payout no lo convirtió en un ID nunca usado: sin restauración
la transacción falló con `entry_archived`; la restauración conservó receptor/importe y el mismo
ID volvió a fallar. Un ID nuevo pagó, antes y después de reiniciar Core y RPC.

La parte experimental pendiente del informe del 1 de noviembre queda realizada. El cierre de
la issue sigue requiriendo revisión independiente y aceptación humana de D-05. No se firma una
garantía financiera en nombre del equipo ni se modifica/despliega el contrato productivo.

## Entorno y artefactos

- Imagen inmutable: `stellar/quickstart@sha256:2aac78f5af01ea8a5f7b04d9419afa1c5bfb869ba4049793368cf965d6befedc`.
- Core 26.1.0, RPC 26.0.0 y host de RPC 26.0.1; protocolo del ledger 26.
- Contrato soroban-sdk 26.1.0; tests Rust usan soroban-env-host 26.1.3. Las versiones se
  distinguen: la ejecución Core no se sustituye por los tests SDK.
- CLI de compilación 28.1.0, Rust 1.99.1, SDK TypeScript 17.2.1, Cargo.lock conservado.
- SHA-256 WASM: `79652abd1645dd763d0f876b73b4e55419452f027e785f5e1cd7f8c73d49f489`.
- SHA-256 `vault/src/lib.rs`: `e6e40611f0ddc5518cf621ecb79476b48873ad0a96ea6bcde75fb9aeaba33b2d`.
- TTL máximo local 1.054.080; mínimo persistente/temporal 16; escaneo de archivo desde nivel 1.
  El intento inicial con máximo 256 fue rechazado por el mínimo de Core, sin inferir resultado financiero.
- Red exclusivamente standalone; HTTP/RPC publicados en `127.0.0.1`. Se usó SAC nativo con XLM
  sintético local, **no USDC público**. El contrato trabaja con la interfaz token de ese SAC.
- Vault `CC7TPFFCMLI5EERKFYZ3MEOTWWD6YAVM3ENAB7F3TSLHYOU3GMJXFBUH`.
- ID original: 32 bytes `01`; controles: 32 bytes `02` y `03`; amount `10000000` = 1 token de 7 decimales.

Artefactos completos: [evidence/soroban-ttl-2026-11-02](evidence/soroban-ttl-2026-11-02/manifest.json).
Incluyen imagen/versiones, entrada Payout, receptor, importes, envelopes y resultados XDR,
hashes de transacción y metadatos. No contienen claves privadas ni credenciales reales.

## Protocolo ejecutado y límites del avance

1. Compilar el Vault existente; crear SAC y cuentas locales; desplegar con owner/operator de la
   raíz sintética y límites suficientes; aportar fondos sintéticos y pagar ID 01 en ledger 137.
2. Registrar `liveUntil=1054216`. Renovar las cinco dependencias del footprint (incluidos código,
   instancia y contador diario) en ledger 226, **excluyendo Payout(01)**. Verificar que su TTL no cambió.
3. Usar `RUN_STANDALONE=true` + `MANUAL_CLOSE=true` de Core para saltos controlados del número
   de ledger. El último salto llegó a 1054215. No se borró ni reescribió Payout. Se preservaron
   configuración, fondos, auth, límites y día UTC; se volvió a modo no-standalone para los cierres siguientes.
4. Someter transacciones firmadas con footprint conocido en 1054216 y 1054217. Ambas fallaron.
   La segunda se construyó sin índices de restauración automática para medir el caso archivado.
5. Publicar un checkpoint contiguo después del salto y reconstruir RPC desde el archivo local.
   Los resultados de los dos ledgers de frontera se exportaron del historial **de Core**, porque
   el RPC nuevo empezó después de esas transacciones. Se conservaron los datos RPC anteriores.
6. Observar Payout archivado (`liveUntil=0`, contenido original disponible), simular reuso,
   restaurar explícitamente, repetir ID 01, pagar ID 02, renovar Payout y comprobar saldos.
7. Renovar dependencias otra vez, reiniciar procesos Core/RPC, crear un cliente nuevo, verificar
   rechazo de ID 01 y pago correcto de ID 03.

**Los saltos no equivalen a reproducir un millón de cierres consecutivos ni a medir coste de
archivo bajo carga pública.** Son la facilidad de prueba de Core para alcanzar el vencimiento;
el rechazo/restauración y las transferencias posteriores sí se ejecutaron como transacciones
sobre su ledger. Se preservó el contenido persistente. No se equiparó archivo a eliminar storage.
Los tiempos no se convierten a días financieros usando un supuesto de segundos por ledger.

## Matriz observada

| Caso | Ledger | Resultado | Saldo receptor (atómicos) |
| --- | ---: | --- | ---: |
| Pago inicial ID 01 | 137 | SUCCESS, Payout creado hasta 1054216 | 1010000000 |
| Reuso antes del TTL | 1054016 | FAILED / trapped; simulación previa Contract #3 | 1010000000 |
| Último ledger vivo | 1054216 | FAILED / trapped, hash verificado en historial Core | 1010000000 |
| Primer ledger vencido, sin autorestore | 1054217 | FAILED / entry_archived | 1010000000 |
| Lectura del registro archivado | 1054233 | liveUntil=0; receptor/importe originales | 1010000000 |
| Simulación tras archivo | 1054233 o posterior | Contract #3 al consultar el ID; no se envía pago | 1010000000 |
| RestoreFootprint explícito | 1054237 | SUCCESS, contenido idéntico; nuevo liveUntil=1054252 | 1010000000 |
| Mismo ID tras restore / cliente nuevo | 1054239 | FAILED; simulación Contract #3 | 1010000000 |
| Control con ID 02 | 1054241 | SUCCESS, una transferencia | 1020000000 |
| Renovación explícita de Payout(01) | 1054243 | SUCCESS, liveUntil=2108322 | 1020000000 |
| Reinicio Core/RPC, cliente nuevo e ID 03 | 1054322 | ID 01 simula Contract #3; ID 03 SUCCESS | 1030000000 |

`trapped` es el resultado del historial de transacción; el historial de frontera no incluye por
sí mismo el código del panic. No se presenta ese campo como si contuviera Contract #3.
Las simulaciones antes/después y el control de saldos complementan esa evidencia.

Hashes principales:

- Último vivo: `2865eebbcf358c7ed6e4754552bc0d60a9a8f8f1274bc80f44a0c09a051bea06`.
- Primer vencido: `3d0f013dc45b216b425d07ca7174ff076a37d2aeb6c218a432aeff0683030d1f`.
- Restore: `00a20424e17ba1c5f045a45be80026a8ffccf578fa7601829a4fc7907d1907f9`.
- ID 02: `cd81fa736bfd0c6054b1d1271a5a69c0a6b119d18a4bc10cfc5ce3f8d17081b8`.
- ID 03 después de reinicio: `c4a16733ba2016643f73ae03ddae09bfe61c6217ddf6e128092189123a7b22ba`.

Coste local observado: restore 37.965 stroops y renovación de Payout 213.768 stroops.
Son costes de esta configuración sintética; no constituyen estimación ni tarifa de mainnet.

## Horizonte y D-05 propuesta para revisión

El registro permaneció vivo desde 137 hasta 1054216 inclusive: 1.054.080 posiciones de ledger.
Tras expirar, la evidencia sobrevivió al archivo, a restore explícito, renovación y reinicio;
se verificó rechazo del mismo ID en esa secuencia hasta el control de ledger 1054322.
No se observa un corte del antirreplay en el TTL medido. Esto **no demuestra un horizonte
infinito**, ni habilita prometer el mismo número en otra red/configuración/protocolo.

**Recomendación D-05:** conservar el contrato actual; mantener IDs estables y backend durable;
tratar archivo como una necesidad de restauración y reconciliación, nunca como autorización
para regenerar un ID o pagar otra vez. Para una garantía operativa concreta, fijar la red,
parámetros de retención, responsable de renovación, presupuesto, alarmas y recuperación de
archivo. Durante indisponibilidad de evidencia, conservar incertidumbre y reserva.

| Alternativa | Garantía y coste | Migración |
| --- | --- | --- |
| Payout persistente + restore, comportamiento actual | Archivo conserva evidencia; depende de disponibilidad/footprint y coste de restore | Sin cambio on-chain |
| Renovación periódica de cada Payout | Reduce interrupciones por archivo; coste/operación proporcional a registros y horizonte | Worker/runbook adicional; aprobación de política y presupuesto |
| ID con época/horizonte validado en contrato | Puede rechazar IDs fuera de época; altera qué solicitudes se admiten | Contrato/ABI nuevos, plan separado y aceptación de producto |
| Registro externo durable | Auditoría y prevención de reenvíos del backend; no impone por sí solo una regla a cualquier operador on-chain | Operación/backups/reconciliación, compatible con contrato actual |

No se confirmó necesidad de un parche on-chain por H-02; no se abrió una issue de arreglo
supuesto. Si se elige renovación automática o un horizonte/época contractual, debe formularse
como propuesta separada con sus costes y criterios de aceptación.

| Aceptación requerida | Estado |
| --- | --- |
| Evidencia reproducible y recomendación técnica | Entregada |
| Revisión de JHAMILCALI y joseemen11 | Pendiente |
| Producto/equipo acepta horizonte y mecanismo D-05 | Pendiente; este documento es propuesta |
| Despliegue/upgrade público | No solicitado ni ejecutado |

## Reproducción y verificación

[Arnés local y procedimiento](../test/local/soroban-ttl/README.md).
Los scripts preservan el trabajo en `scratch/ttl` y rechazan un bootstrap sobre estado existente.
La secuencia consolidada incorpora lo aprendido durante la exploración y fue comprobada
sintácticamente; no se ejecutó una segunda corrida completa desde cero con ese empaquetado.
Las operaciones/afirmaciones de la matriz sí fueron ejecutadas y sus resultados se conservaron.

```bash
npm test                                              # 215/215
npm run typecheck                                     # OK
python3 test/unit/deploy-testnet.test.py               # 5/5
# Desde contracts/soroban:
cargo test --locked --offline -p tilcai-vault           # 12/12
# Desde raíz:
node --test test/local/soroban-ttl/evidence.test.mjs     # 5/5
```

Los cinco tests de artefactos verifican hashes/envelopes, resultados XDR, frontera exacta,
contenido idéntico antes/después de restore, controles de saldo y renovación. No sustituyen
la ejecución local: permiten auditar offline los resultados guardados de esa ejecución.
No se ejecutaron las suites con RPC financiero, Circle, Relayer o pagos públicos.

## Fuentes primarias consultadas

- [CAP-0046-12: state archival](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-12.md).
- [CAP-0066: automatic restoration](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0066.md).
- [Quickstart](https://github.com/stellar/quickstart), configuraciones del commit indicado en el arnés.
- [Core 26.1.0, manualClose y avance controlado](https://github.com/stellar/stellar-core/blob/v26.1.0/src/main/ApplicationImpl.cpp).
- [Operación manual de Quickstart](https://developers.stellar.org/docs/tools/quickstart/advanced-usage/operation-modes).

Durante la preparación se descartó la imagen latest de Core/RPC 30: su RPC no simula protocolo
26 y su XDR nuevo no es compatible con todos los decodificadores del SDK del repositorio.
La matriz válida se obtuvo con la imagen histórica fijada de Core/RPC 26, sin actualizar
las dependencias de producción. Se detuvo Friendbot para evitar interferencia de nonce con
la cuenta raíz sintética. Los contenedores de investigación se detuvieron tras exportar evidencia.
