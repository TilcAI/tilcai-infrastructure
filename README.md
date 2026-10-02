# tilcai-infrastructure

Backend e infraestructura de TilcAI: gateway, rieles de pago (x402 sobre Stellar y USDC crosschain con Circle CCTP V2), integración con el OpenZeppelin Relayer y, por fases, cuentas abstractas, paymasters, ERC-8004, MCP y A2A.

Plan y arquitectura completos: [`documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md`](../documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md).

> **Solo testnet.** La configuración rechaza cualquier entorno distinto de `testnet`. Nada de esto está auditado.

## Estado

| Capacidad | Estado |
| --- | --- |
| Fase 1 — pago USDC Avalanche Fuji → Stellar Testnet (CCTP V2 + CctpForwarder) | **Implementado y verificado con transferencias reales** (2026-10-02). 25 tests unitarios + 3 de integración on-chain. |
| Origen gasless: el pagador firma EIP-3009 y el OZ Relayer envía el burn (`TilcaiCctpRouter`, Fuji `0x297ce6a2787484db4bB18A96a8F28A9881Fc163C`) | **Desplegado y verificado**: burn enviado por la cuenta del relayer; el pagador no gastó AVAX |
| Destino gasless: el Relayer envía `mint_and_forward` y paga el XLM | Verificado (fee account = firmante del relayer) |
| Estructura de módulos de las fases 2–5 (`src/modules/*/ports.ts`) | Interfaces sin implementación |
| Contratos | EVM: `TilcaiCctpRouter` desplegado en Fuji (4 tests Foundry). Soroban: solo esqueleto |

## Modos de pago

| `mode` | Quién firma | Gas del burn en Fuji | Gas del mint en Stellar |
| --- | --- | --- | --- |
| `gasless` | Wallet del pagador firma EIP-3009 (`eth_signTypedData_v4`) | **Relayer** (`avalanche-fuji-relayer`) | **Relayer** (`stellar-example`) |
| `dev_gasless` | Clave de desarrollo (testnet) firma EIP-3009 | **Relayer** | **Relayer** |
| `external` | Wallet del pagador difunde `approve` + burn | Pagador (AVAX) | Relayer |
| `dev_signer` | Clave de desarrollo difunde el burn | Clave de desarrollo (AVAX) | Relayer |

En los modos gasless la firma del pagador compromete el destino CCTP completo (el nonce EIP-3009 es un hash de `paymentId`, importe, dominio, `mintRecipient`, `destinationCaller`, `maxFee`, finalidad y `hookData`). El relayer solo puede enviar exactamente lo firmado.

## Flujo de la fase 1

```
payer (Fuji)                TilcAI API + worker                          Circle Iris        Stellar (Relayer paga XLM)
  │  POST /quotes  ───────▶ ruta, fee (0 bps Standard), preflight trustline
  │  POST /payments ──────▶ AWAITING_BURN + llamadas sin firmar (approve exacto + depositForBurnWithHook)
  │  firma y difunde ─────▶ POST /payments/:id/burn {txHash}  → BURN_SUBMITTED (hash persistido)
  │                         worker: recibo + evento DepositForBurn == cotización → BURN_CONFIRMED
  │                         worker: atestación ─────────────────────────────▶ /v2/messages
  │                         decodifica el mensaje crudo y lo vuelve a verificar → ATTESTED
  │                         ¿nonce usado? sí → SETTLED; no → mint_and_forward vía Relayer → MINT_SUBMITTED
  │                         tx SUCCESS + nonce usado → SETTLED + recibo de pago ─────────────────▶ USDC al payTo
```

- El destinatario en el burn es **siempre** el `CctpForwarder` (como `mintRecipient` y `destinationCaller`), y el `G…` final viaja en `hookData`. Poner un `G…` directamente deja los fondos atascados.
- Un burn respalda como máximo un pago, y un nonce CCTP una sola liquidación (índices únicos).
- El mint es idempotente por el nonce de CCTP: se reintenta sin riesgo. Nunca se crea un segundo burn para un pago existente.
- Un burn no encontrado o una atestación que no coincide pasan a `UNCERTAIN` y no se mintean. Nunca se marcan `FAILED` sin evidencia.

## Uso

```sh
npm install
cp .env.example .env         # completar RELAYER_API_KEY y, para pruebas, DEV_EVM_PAYER_PRIVATE_KEY
npm test                     # unitarios (sin red)
npm run typecheck
npm run relayer:check        # salud, auth, x402 /supported y relayer Stellar
npm start                    # API (127.0.0.1:8787) + worker en un proceso
```

Pago de prueba de extremo a extremo (mueve fondos de **testnet**):

```sh
# gasless (el relayer paga el gas en las dos redes):
npm run xpay -- --amount 0.1 --to G…MERCHANT_CON_TRUSTLINE_USDC --gasless
# con la clave de desarrollo difundiendo el burn (necesita AVAX en Fuji):
npm run xpay -- --amount 0.1 --to G…MERCHANT_CON_TRUSTLINE_USDC
# con wallet externa: imprime las llamadas sin firmar
npm run xpay -- --amount 0.1 --to G… --payer 0x…
npm run xpay -- --payment payment_attempt_… --burn 0x…HASH
```

### API (v1)

Todas las rutas salvo `/health` exigen `Authorization: Bearer <TILCAI_API_KEYS>` (si la lista está vacía, solo se acepta loopback).

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/health` | Estado y Relayer arriba/abajo |
| GET | `/v1/routes` | Rutas crosschain habilitadas |
| POST | `/v1/crosschain/quotes` | `{sourceNetwork:"eip155:43113", destinationNetwork:"stellar:testnet", amount:"1.25", payTo:"G…"}` |
| GET | `/v1/crosschain/quotes/:id` | Cotización |
| POST | `/v1/crosschain/payments` | Cabecera `Idempotency-Key`. `{quoteId, mode:"external"\|"dev_signer", payer?, orderId?}` → pago + `unsignedCalls` |
| POST | `/v1/crosschain/payments/:id/authorization` | Modo `gasless`: `{signature}` (65 bytes hex) de `authorization.typedData`. TilcAI la verifica contra el pagador, la persiste y pide al relayer que envíe el burn |
| POST | `/v1/crosschain/payments/:id/burn` | `{txHash}` del burn difundido por la wallet externa (también rescata un pago gasless cuyo hash se perdió) |
| GET | `/v1/crosschain/payments/:id` | Estado detallado, `paymentState` compartido, enlaces, eventos y recibo |
| POST | `/v1/crosschain/payments/:id/reconcile` | Ejecuta un paso de conciliación inmediatamente |
| GET | `/v1/relayer/status` | x402 `/supported` y relayer Stellar |

Los errores usan el envelope `tilcai-shared-v1` de `tilcai-core` (`code`, `message`, `recovery`).

## Despliegue

TilcAI y el Relayer comparten host: `RELAYER_URL=http://localhost:8080`, `API_HOST=127.0.0.1`. Para probar desde otra máquina de la LAN: `RELAYER_URL=http://192.168.1.57:8080`.

```ini
# /etc/systemd/system/tilcai.service (ejemplo)
[Service]
WorkingDirectory=/opt/tilcai/tilcai-infrastructure
EnvironmentFile=/opt/tilcai/tilcai-infrastructure/.env
ExecStart=/usr/bin/npm start
Restart=always
User=tilcai
```

## Estructura

```
src/
  config/            env validado (zod), registro de redes CAIP-2 y direcciones CCTP verificadas
  db/                SQLite (node:sqlite, WAL) + migraciones; repositorios detrás de interfaces (Postgres en fase 2)
  shared/            importes atómicos exactos, hex, IDs tilcai-shared-v1, errores de dominio, logger
  modules/
    crosschain/      FASE 1: cctp/ (encoding, decoder V2, Iris), adapters/ (viem, Soroban, submitters), service, verify
    relayer/         cliente HTTP del OpenZeppelin Relayer (transacciones Stellar, plugin x402)
    principals/ agents/ businesses/ commerce/ identity/ policies/ budgets/
    authorization/ accounts/ signers/ payments/ receipts/   puertos de las fases 2–5
    connectors/mcp  connectors/a2a  jobs/
  apps/              api (Fastify), worker, all-in-one, cli (xpay, relayer:check)
contracts/evm        Foundry: TilcaiCctpRouter (desplegado en Fuji), paymaster ERC-4337 (fase 3)
contracts/soroban    política de gasto para smart accounts y presupuesto (fase 3)
test/unit            25 tests sin red     test/integration   relayer y e2e reales (se omiten sin credenciales)
```
