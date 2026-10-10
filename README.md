# tilcai-infrastructure

Backend e infraestructura de TilcAI: gateway, rieles de pago (x402 sobre Stellar y USDC crosschain con Circle CCTP V2), vault de desembolsos en Avalanche, cobro con QR Simple (mock), eventos para el tablero de monitorización, integración con el OpenZeppelin Relayer y, por fases, cuentas abstractas, paymasters, ERC-8004, MCP y A2A.

Plan y arquitectura completos: [`documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md`](../documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md).

> **Mainnet todavía no está habilitada para operar.** La Fase 1 añade selección segura de
> `testnet`/`mainnet`, direcciones oficiales de USDC y CCTP y aislamiento de configuración. Los
> contratos TilcAI no están auditados ni desplegados en mainnet, sus direcciones son obligatorias
> y no tienen valores por defecto. Además, `MAINNET_TRANSACTIONS_ENABLED=false` mantiene la API
> mainnet en modo sin transacciones. No cambies ese interruptor antes de la revisión de Fase 2.
> La preparación de despliegue, exclusivamente de lectura/dry-run, está en
> [`deploy/MAINNET_DEPLOYMENT.md`](deploy/MAINNET_DEPLOYMENT.md).

## Estado

| Capacidad | Estado |
| --- | --- |
| Soporte Mainnet — Avalanche C-Chain + Stellar Public Network | **Fase 1 implementada, no operativa**: selección multired, configuración aislada y validación fail-closed. Sin despliegues, fondos ni transacciones mainnet. |
| Fase 1 — pago USDC Avalanche Fuji → Stellar Testnet (CCTP V2 + CctpForwarder) | **Implementado y verificado con transferencias reales** (2026-10-02). 25 tests unitarios + 3 de integración on-chain. |
| Origen gasless: el pagador firma EIP-3009 y el OZ Relayer envía el burn (`TilcaiCctpRouter`, Fuji `0x297ce6a2787484db4bB18A96a8F28A9881Fc163C`) | **Desplegado y verificado**: burn enviado por la cuenta del relayer; el pagador no gastó AVAX |
| Destino gasless: el Relayer envía `mint_and_forward` y paga el XLM | Verificado (fee account = firmante del relayer) |
| Vault de desembolsos: paga en USDC las compras cobradas fuera de la cadena (`TilcaiVault`, Fuji `0x841dD47Db3124839be1D878DD277e1b07D6932b6`) | **Desplegado** (2026-10-07). El relayer envía `disburse` y paga el gas; el contrato limita cada pago, el total diario y paga cada id una sola vez. 13 tests Foundry + 16 unitarios |
| Cobro con QR Simple: mock de la API de Vendis («QR Dinámico para Pagos» v1.3) con página «Simular depósito» | **Implementado como mock** (2026-10-09): no hay banco ni dinero. Verificado de extremo a extremo con optipagos-backend: QR → depósito simulado → notificación → desembolso del vault en Fuji |
| Monitorización: registro de eventos, recursos y alertas; avisos del relayer por webhook; envío firmado a tilcai-web | **Implementado** (2026-10-09). El receptor de avisos del relayer está probado con avisos firmados de prueba; falta apuntar el relayer real a TilcAI |
| Fase SCA, EVM — cuentas de contrato con passkey para terceros (`TilcaiAccountFactory`, Fuji `0x55a5b0ed47c5dfb168cfe2b431a56455576d51b8`; `TilcaiCctpRouterV2`, Fuji `0x09483803916e6cb2027741c9287361ad55507a66`) | **Desplegado en testnet y verificado** (2026-10-09, `npm run sca -- verify`): una cuenta emitida por la factory pagó USDC real de Fuji con una firma de passkey (ERC-1271 + ERC-7739). API `/v1/accounts`, claves por tercero con permisos y modo de pago `account`. Contratos **sin auditar: solo testnet**. Falta: delegación a claves de agente (M4) y envío de UserOperations |
| Fase SCA, Stellar — emisión de cuentas (`tilcai_account_factory`) y vault de USDC (`tilcai_vault`) | **Desplegado en testnet y verificado** (2026-10-09, `npm run stellar -- verify-account` y `verify-vault`): el relayer despliega la cuenta del tercero por la factory sin que el dueño tenga XLM, y desembolsa USDC desde el vault igual que en Avalanche. API `/v1/accounts` con `network:"stellar:testnet"` y `/v1/vault?network=stellar:testnet`. 17 tests de Soroban + 14 unitarios. **Sin auditar: solo testnet.** Falta: delegación a claves de agente (M3) |
| Estructura de módulos de las fases 2–5 (`src/modules/*/ports.ts`) | Interfaces sin implementación |
| Contratos | EVM: `TilcaiCctpRouter`, `TilcaiVault`, `TilcaiAccountFactory` (+ `TilcaiAccount`) y `TilcaiCctpRouterV2` desplegados en Fuji (38 tests Foundry). Soroban: cuenta, factory, verificadores y política de límite sobre OpenZeppelin `stellar-accounts` 0.7.2, y `tilcai_vault` (19 tests; desplegados en Stellar Testnet salvo la política) |

## Modos de pago

| `mode` | Quién firma | Gas del burn en Fuji | Gas del mint en Stellar |
| --- | --- | --- | --- |
| `gasless` | Wallet del pagador firma EIP-3009 (`eth_signTypedData_v4`) | **Relayer** (`avalanche-fuji-relayer`) | **Relayer** (`stellar-example`) |
| `dev_gasless` | Clave de desarrollo (testnet) firma EIP-3009 | **Relayer** | **Relayer** |
| `external` | Wallet del pagador difunde `approve` + burn | Pagador (AVAX) | Relayer |
| `dev_signer` | Clave de desarrollo difunde el burn | Clave de desarrollo (AVAX) | Relayer |
| `account` | La passkey del dueño de una cuenta emitida por TilcAI firma el mismo EIP-3009 (ERC-1271) | **Relayer**, por `TilcaiCctpRouterV2` | **Relayer** |

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
npm run sca:preflight        # prerrequisitos de la fase SCA: Fuji, Stellar, relayer y herramientas (solo lectura)
npm run vault -- status      # el vault en la cadena: saldo, límites, dueño y operador
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

Todas las rutas salvo `/health` exigen `Authorization: Bearer <clave>`. Cada clave pertenece a un
tercero (*tenant*) y lleva permisos:

- Las claves de `TILCAI_API_KEYS` son las del operador: permiso `payments` y acceso a lo que es de
  TilcAI (`/v1/vault`, `/v1/monitor`, `/v1/relayer`). Optipagos y optus-agentBE siguen igual.
- Las claves emitidas con `npm run tenant -- key` pertenecen a un tercero y solo ven lo suyo:
  `payments` para cotizar y pagar, `accounts:read` y `accounts:write` para sus cuentas. Nunca
  alcanzan el vault, el registro de eventos ni el relayer (403).
- Sin `TILCAI_API_KEYS`, solo loopback entra, como operador con todos los permisos (desarrollo).

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/health` | Estado y Relayer arriba/abajo |
| GET | `/v1/routes` | Rutas crosschain habilitadas |
| POST | `/v1/crosschain/quotes` | `{sourceNetwork:"eip155:43113", destinationNetwork:"stellar:testnet", amount:"1.25", payTo:"G…"}` |
| GET | `/v1/crosschain/quotes/:id` | Cotización |
| POST | `/v1/crosschain/payments` | Cabecera `Idempotency-Key`. `{quoteId, mode:"external"\|"dev_signer", payer?, orderId?}` → pago + `unsignedCalls` |
| POST | `/v1/crosschain/payments/:id/authorization` | Modo `gasless`: `{signature}` (65 bytes hex) de `authorization.typedData`. Modo `account`: `{webauthn:{authenticatorData, clientDataJSON, signature}}` (base64url, tal como lo devuelve el navegador) o `{signature}` con la firma ERC-1271 ya armada. TilcAI la verifica contra el pagador, la persiste y pide al relayer que envíe el burn |
| POST | `/v1/crosschain/payments/:id/burn` | `{txHash}` del burn difundido por la wallet externa (también rescata un pago gasless cuyo hash se perdió) |
| GET | `/v1/crosschain/payments/:id` | Estado detallado, `paymentState` compartido, enlaces, eventos y recibo |
| POST | `/v1/crosschain/payments/:id/reconcile` | Ejecuta un paso de conciliación inmediatamente |
| POST | `/v1/accounts` | Cabecera `Idempotency-Key`. `{network:"eip155:43113" \| "stellar:testnet", externalRef, owner}` → cuenta con su dirección definitiva. `owner`: `{kind:"webauthn-p256", publicKey, credentialId, rpId}` (ambas redes) o `{kind:"ed25519", publicKey}` (solo Stellar). Permiso `accounts:write` |
| GET | `/v1/accounts/:id` | La cuenta (`DEPLOYING` → `ACTIVE`), enlaces y eventos. Permiso `accounts:read` |
| GET | `/v1/accounts` | Las cuentas del tercero; filtros `externalRef`, `network`, `limit` |
| GET | `/v1/vault` | El vault en la cadena: saldo, límites, pausa, dueño, operador y lo comprometido en pagos en curso. `?network=` elige la red; sin él, Fuji |
| POST | `/v1/vault/disbursements` | Cabecera `Idempotency-Key`. `{network?, to:"0x…" \| "G…" \| "C…", amount:"10.5", reference?:"compra-123"}` → desembolso. El relayer envía `disburse` del vault de la red y paga el gas. Sin `network`, Fuji |
| GET | `/v1/vault/disbursements/:id` | Estado (`REQUESTED` → `SUBMITTED` → `CONFIRMED` \| `FAILED`), hash, enlace y eventos |
| POST | `/v1/vault/disbursements/:id/reconcile` | Ejecuta un paso de conciliación inmediatamente |
| GET | `/v1/relayer/status` | x402 `/supported` y relayer Stellar |
| GET | `/v1/monitor/events` | El registro de eventos: `?after=<seq>` para lo que vino después, sin `after` los últimos. Filtros `type` (exacto o prefijo `vault.`), `source`, `severity`, `limit` |
| GET | `/v1/monitor/stream` | Lo mismo en vivo (Server-Sent Events; `?after=<seq>` o `Last-Event-ID` para reanudar) |
| GET | `/v1/monitor/resources` | Proceso, base de datos, colas, relayer y vault ahora mismo, y las alertas activas |
| POST | `/v1/webhooks/relayer` | Avisos del OpenZeppelin Relayer. No usa clave Bearer: los firma el relayer (`X-Signature`) |
| — | `/mock/vendis/…` | Mock de QR Simple, solo con `QR_MOCK_ENABLED=true`. Usa los tokens de su propio `login` (ver abajo) |

Los errores usan el envelope `tilcai-shared-v1` de `tilcai-core` (`code`, `message`, `recovery`).

## Vault de desembolsos

Para vender USDC cobrando por fuera de la cadena (un QR bancario, una transferencia): quien
cobra confirma el pago y pide a TilcAI que entregue los USDC a la wallet del comprador.

```
optipagos (u otro servicio)          TilcAI API + worker                 OZ Relayer            TilcaiVault (Fuji)
  │ POST /v1/vault/disbursements ──▶ valida, comprueba que el vault puede pagar → REQUESTED
  │                                  simula y envía disburse(id, to, amount) ──▶ paga el gas ──▶ transfiere USDC
  │                                  worker: recibo + evento Disbursed == pedido → CONFIRMED
  │ GET  /v1/vault/disbursements/:id ◀─ estado, txHash y enlace
```

- **Un pago por id.** El contrato anota cada `disbursementId` y se niega a pagarlo dos veces,
  así que un pago se reintenta sin riesgo: una transacción repetida o tardía solo puede revertir.
- **Una compra, un pago.** `reference` es el id de quien llama (la compra); no admite un segundo
  desembolso mientras el primero no haya fallado. `Idempotency-Key` hace repetible la petición.
- **Límites en la cadena.** Tope por pago y tope por día (UTC) que solo el dueño cambia; el
  operador (la cuenta del relayer) no puede saltárselos ni retirar fondos.
- **Respuesta clara si no puede pagar.** Vault en pausa → `PAUSED`; monto sobre los límites →
  `PAYMENT_LIMIT`; saldo insuficiente (contando lo ya comprometido) → `BUDGET`. No se crea nada
  y quien llama puede repetir la misma petición más tarde.
- `FAILED` solo cuando todos los intentos demostraron no haber pagado. Una llamada al relayer
  sin respuesta lo deja `uncertain` y se sigue conciliando contra la cadena.

```sh
cd contracts/evm && forge build && cd ../..
npm run vault -- deploy --max 100 --daily 1000   # firma DEV_EVM_PAYER_PRIVATE_KEY; operador = cuenta RELAYER_FUJI_ID
# VAULT_FUJI=0x… en .env, y recargarlo enviando USDC de Fuji a esa dirección
npm run vault -- status
npm run vault -- withdraw --to 0x… --amount 5    # el dueño recupera fondos
```

La dirección del vault y la clave de la API permiten pagar hasta los límites del contrato:
`TILCAI_API_KEYS` debe estar definida en cualquier despliegue que tenga `VAULT_FUJI`.

## Cuentas de contrato (fase SCA, EVM)

TilcAI emite y patrocina cuentas para los usuarios de un tercero; **nunca es firmante** de una
cuenta que emite. El dueño es una passkey que no sale del dispositivo del usuario.

```
tercero (Optipagos)                TilcAI API + worker                OZ Relayer          Avalanche Fuji
  │ POST /v1/accounts {clave pública de la passkey}
  │                          ──▶ dirección = factory.getAddress(clave, salt) → DEPLOYING
  │ ◀── dirección definitiva      envía factory.createAccount ──────▶ paga el gas ──▶ TilcaiAccount (clon)
  │                               worker: la dirección tiene código → ACTIVE
  │ POST /v1/crosschain/payments {mode:"account", payer}
  │ ◀── authorization.account.challenge
  │ passkey: navigator.credentials.get({challenge})
  │ POST …/authorization {webauthn} ─▶ isValidSignature en la cadena ─▶ router v2 ──▶ USDC → CCTP
```

- **La dirección compromete al dueño.** Sale de la clave pública, el tercero y su `externalRef`:
  nadie puede desplegar ahí otra cuenta, y pedirla dos veces devuelve la misma. Puede recibir
  fondos antes de estar desplegada; para firmar necesita estar `ACTIVE`.
- **Qué firma la passkey.** Nunca el hash de la aplicación a secas: un `TypedDataSign` (ERC-7739)
  que envuelve el mensaje y nombra la cuenta, así una firma no vale en otra cuenta de la misma
  passkey. La cuenta exige verificación del usuario (huella o PIN), `webauthn.get` y firma con `s` baja.
- **Pagos.** La cuenta paga USDC con EIP-3009 y firma `bytes` (`transferWithAuthorization` directo,
  o `TilcaiCctpRouterV2` para CCTP): quien envía la transacción solo entrega lo firmado.
- **Cupos.** Cada tercero tiene un cupo diario de cuentas; agotado, `POST /v1/accounts` responde
  429 `BUDGET` y no guarda nada. Un despliegue rechazado se reintenta y avisa al panel
  (`account.deploy_delayed`); la cuenta nunca se da por perdida.

```sh
cd contracts/evm && forge build && cd ../..
npm run sca -- deploy          # factory y router v2; firma DEV_EVM_PAYER_PRIVATE_KEY
# ACCOUNT_FACTORY_FUJI=0x… y CCTP_ROUTER_V2_FUJI=0x… en .env
npm run sca -- status
npm run sca -- verify          # emite una cuenta de prueba y la hace pagar 0.01 USDC con firma de passkey
npm run tenant -- create --name Optus
npm run tenant -- key --tenant tenant_… --label backend --scopes payments,accounts:read,accounts:write
```

Los contratos no están auditados y la configuración solo admite testnet.

## Stellar: cuentas y vault (fase SCA)

Lo mismo que en Avalanche, en Soroban, con los mismos contratos de OpenZeppelin `stellar-accounts`
como base y la misma API. Cambia la red en la petición: `network:"stellar:testnet"`.

- **Cuentas.** `tilcai_account_factory` despliega `tilcai_account` en una dirección derivada de la
  clave del dueño y de un salt (`sha256(dominio ‖ tipo ‖ firmante ‖ salt)`): se conoce antes de
  desplegar, compromete al dueño y desplegar no exige autorización, así que paga el relayer. El
  dueño es un firmante externo: una clave **Ed25519** (un keypair de Stellar) o una **passkey**
  P-256 que verifica el contrato `webauthn-verifier`. TilcAI no queda como firmante ni como
  administrador de nada. La cuenta no es actualizable.
- **Vault.** `tilcai_vault` reproduce `TilcaiVault`: un pago por `disbursementId`, tope por pago y
  por día UTC, pausa, retiro del dueño, cambio de operador y de dueño en dos pasos. El operador es la
  cuenta del relayer y autoriza como fuente de la transacción. Paga a cuentas `G…` (con trustline
  de USDC) y a contratos `C…` (sin trustline, como las cuentas emitidas por la factory).
- **Mismo servicio.** `VaultDisbursementService` sirve a las dos redes: un servicio por red sobre
  el mismo repositorio, cada uno concilia solo lo suyo. En Stellar un ledger cerrado es final, así
  que basta una confirmación; el registro `payout(id)` del contrato decide si un id se pagó, y el
  evento `disbursed` aporta el hash mientras el nodo lo conserve.

```sh
cd contracts/soroban && cargo test && cd ../..            # 19 tests (antes: stellar contract build, para que existan los wasm)
npm run stellar -- relayer                                 # cuenta G… del relayer: operador del vault
contracts/soroban/deploy-testnet.sh --source <identidad> --operator G… [--owner G…] [--max 100] [--daily 1000]
# ACCOUNT_FACTORY_STELLAR=C… y VAULT_STELLAR=C… en .env; recargar el vault enviándole USDC a la dirección C…
npm run stellar -- status
npm run stellar -- verify-account                          # emite una cuenta de prueba por el relayer y comprueba su regla owner
npm run stellar -- verify-vault --pay G… --amount 0.1      # comprueba los topes y hace un desembolso real
```

Contratos en Stellar Testnet (2026-10-09): factory `CCQCZQGQTUESUBMBPKQWHDZYKAVKFIL3VHZGV2YRCJ4Q7AYA5OWRU2ZB`,
verificador Ed25519 `CDKHWRLYZRCLJK4CJY7C5G76AII77AUSMNIHWZIDIT5EMAJOBXF65QYP`, verificador WebAuthn
`CBBPAL5S7XWTXZYSNLMQAQQ6QJYW3HMDWWJ2BGKPX6K2VOVGJQM2RWC6`, vault `CDQ5KG2WCKHOI5MXGNB6X4662ONAWOZUGZFA7HTG6VAZPVU7MBLOAVI6`
(dueño: una cuenta de desarrollo; **en producción, una multifirma o una cuenta inteligente**: puede vaciar el vault).
El estado de Soroban expira: una cuenta o un vault sin uso se archivan hasta restaurarlos. Cada
llamada al vault y a la factory extiende su TTL; el vault extiende también el de cada pago.

## QR Simple (mock)

Para cobrar en bolivianos con el QR del banco sin tener todavía un proveedor: TilcAI hace de
pasarela y responde como la API de **Vendis, «QR Dinámico para Pagos» v1.3**. Quien integra
contra el mock integra contra Vendis: cambia la URL base y las credenciales. No hay banco ni
dinero; un pago ocurre cuando alguien pulsa **Simular depósito**.

```
optipagos (quien cobra)              TilcAI · /mock/vendis                    navegador
  │ POST api/v1/login ─────────────▶ token (vigencia: un año)
  │ POST api/v1/devices/simple-qr/generate ─▶ qr_image (PNG en base64), qr_url, qr_id   → Pendiente
  │                                  GET /mock/vendis/  ◀──────────── «Simular depósito» (un botón)
  │ POST …/simple-qr/callback ◀───── {payment_date, payment_amount, qr_id, payment_name, payment_bank}
  │      responde {success:true}     reintenta 3 veces (5 s, 15 s, 45 s)                 → Pagado
  │ GET  api/v1/devices/simple-qr/get/<qr_id> ─▶ {status, payments[]}   (por si el aviso se pierde)
```

| Método | Ruta (bajo `/mock/vendis`) | Qué hace |
| --- | --- | --- |
| POST | `/api/v1/login` | `{email, password, token_name}` → `{access_token}`. Error: `401 {"message":"Credenciales Inválidos"}` |
| POST | `/api/v1/devices/simple-qr/generate` | `Bearer <token>`. `{device_id, amount, modify_amount, is_multi_use, qr_expiration:"Y-m-d H:i:s", description}` → `{success, data:{qr_image, qr_url, qr_id}}` |
| GET | `/api/v1/devices/simple-qr/get/<qr_id>` | `Bearer <token>` → `{success, data:{status, payments}}`. `status`: `Pendiente`, `Pagado`, `Anulado` o `Fallido` |
| GET | `/qr-image/<archivo>` | La imagen de `qr_url` |
| GET | `/` | La página con el botón **Simular depósito** (`?qr=<qr_id>` elige otro QR pendiente) |
| GET | `/simulate/pending` | Los QR que esperan pago |
| POST | `/simulate/deposit` | `{qr_id?, amount?, payment_name?, payment_bank?}`: paga el QR (sin `qr_id`, el pendiente más reciente) y envía el aviso |

- **El QR** tiene la forma de un QR Simple real: un bloque opaco en base64, una barra y un
  identificador, con el distintivo «$» en el centro. Lleva corrección de errores H: quien
  rediseñe la tarjeta puede tapar el centro con su marca y se sigue leyendo lo mismo.
- **Fechas** en hora de Bolivia (UTC−4), como las entrega un servicio boliviano; montos en
  bolivianos con dos decimales.
- **El aviso** va a `QR_MOCK_CALLBACK_URL` con el token del QR en `Authorization`. Se da por
  entregado con un `2xx` y `{"success": true}`. Quien lo recibe debería confirmar el pago
  consultando el estado del QR antes de entregar nada: el aviso solo dispara la consulta.
- **El simulador** se abre sin clave desde el propio equipo. Desde otro, con
  `?key=<QR_MOCK_SIMULATOR_KEY>` o una clave de `TILCAI_API_KEYS`.
- Lo que el mock decide por su cuenta, porque la documentación no lo dice: un QR vencido sin
  pagar pasa a `Anulado`, y un QR de monto abierto se paga con Bs 10.00 si nadie indica otro.

```sh
QR_MOCK_ENABLED=true QR_MOCK_EMAIL=caja@ejemplo.bo QR_MOCK_PASSWORD=… \
QR_MOCK_CALLBACK_URL=http://localhost:3200/api/v1/devices/simple-qr/callback npm start
# abrir http://127.0.0.1:8787/mock/vendis/
```

## Monitorización

TilcAI anota en su base lo que le pasa y lo que le cuentan, y lo envía a `tilcai-web`, que lo
muestra en el tablero. La explicación completa, con el contrato y los pasos para conectarlos,
está en [`documentation/2-ARQUITECTURA/TILCAI_MONITORIZACION_EVENTOS_BACKEND_FRONTEND_2026-10-09.md`](../documentation/2-ARQUITECTURA/TILCAI_MONITORIZACION_EVENTOS_BACKEND_FRONTEND_2026-10-09.md).

```
servicios (pagos, vault, API) ─┐
avisos del relayer (webhook) ──┼─▶ monitor_events (SQLite, seq creciente) ─▶ POST firmado ─▶ tilcai-web
mock de QR Simple ─────────────┤        ▲                                    (reintenta; no pierde orden)
foto de recursos cada 30 s ────┘        └── GET /v1/monitor/events · /stream · /resources
```

- **Eventos** (`tilcai-monitor-v1`): `{seq, id, type, source, severity, subject, summary, data, at}`.
  Los tipos están en [`src/modules/monitor/domain.ts`](src/modules/monitor/domain.ts):
  `system.*`, `resources.snapshot`, `alert.*`, `api.request_rejected`,
  `crosschain.payment.*`, `vault.disbursement.*`, `relayer.*` y `qr.*`.
- **Recursos**: memoria, CPU y retraso del event loop del proceso; tamaño de la base y filas por
  estado de cada cola; saldo de gas y estado de cada relayer; saldo, límites y pausa de cada vault
  (Fuji y Stellar; las alertas del segundo llevan la red: `VAULT_EMPTY:stellar:testnet`).
- **Alertas**: lo que está mal ahora (`VAULT_EMPTY`, `VAULT_LOW`, `RELAYER_DOWN`,
  `RELAYER_LOW_GAS:<id>`, `MONITOR_SINK_FAILING:web`…). Un evento cuando aparece y otro cuando
  se resuelve, no uno por cada foto.
- **Envío a tilcai-web**: por lotes, en orden y al menos una vez. El cursor solo avanza con un
  `2xx`, así que un tablero caído recibe después todo lo que se perdió. Cada envío va firmado:
  `X-Tilcai-Signature: v1=HMAC-SHA256(secreto, "<X-Tilcai-Timestamp>.<cuerpo>")`.
- **Avisos del relayer**: se guardan una vez (por su `id`) y, si la transacción la envió
  TilcAI, enlazan con su pago o su desembolso. Sirven para ver, no para decidir: un pago solo
  se liquida cuando TilcAI comprobó la cadena.
- Emitir un evento nunca rompe ni retrasa un pago: si no se puede guardar, se registra en el log
  y se sigue. El envío al tablero y el reloj del mock corren en un bucle aparte del de
  conciliación.

## Despliegue

TilcAI necesita el OpenZeppelin Relayer (con el plugin `x402`) y un Redis para el relayer.

**En contenedores** (un host con Docker Compose, Google Cloud Run, AWS o Azure): imágenes,
configuración del relayer y guía en [`deploy/`](deploy/README.md).

```sh
cp deploy/.env.example deploy/.env       # completar los secretos
./deploy/build.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

**Sin contenedores**, TilcAI y el Relayer comparten host: `RELAYER_URL=http://localhost:8080`, `API_HOST=127.0.0.1`. Para probar desde otra máquina de la LAN: `RELAYER_URL=http://192.168.1.57:8080`.

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
    vault/           desembolsos del vault de cada red: service (conciliación), repository, adapters/ (viem, Soroban)
    stellar/         lectura de Soroban (simulación, estado) y envío de llamadas por el relayer
    monitor/         registro de eventos, foto de recursos y alertas, avisos del relayer, envío a tilcai-web
    qrsimple/        mock de QR Simple (API de Vendis): tokens, QR, pagos simulados, callback y su página
    relayer/         cliente HTTP del OpenZeppelin Relayer (transacciones Stellar, plugin x402)
    principals/ agents/ businesses/ commerce/ identity/ policies/ budgets/
    authorization/ signers/ payments/ receipts/             puertos de las fases 2–5
    tenants/         terceros: claves con permisos y cupos diarios (CLI `npm run tenant`)
    accounts/        fase SCA: emisión de cuentas (service), evm/ (firma de passkey, factory), stellar/ (factory Soroban), repositorio
    connectors/mcp  connectors/a2a  jobs/
  apps/              api (Fastify), worker, all-in-one, cli (xpay, relayer:check, sca:preflight, sca, vault, stellar, tenant)
contracts/evm        Foundry: TilcaiCctpRouter, TilcaiVault, TilcaiAccount + TilcaiAccountFactory y TilcaiCctpRouterV2 (desplegados en Fuji)
contracts/soroban    Cargo: cuenta, factory, vault, verificadores y política de límite (OpenZeppelin); política propia pendiente (M3)
test/unit            174 tests sin red     test/integration   relayer y e2e reales (se omiten sin credenciales)
deploy/              imágenes Docker de TilcAI y del relayer, compose del stack y manifiestos de Cloud Run
```
