# Mainnet: estado, operación y despliegues pendientes

> Estado al 2026-10-10: **los pagos crosschain Avalanche → Stellar funcionan en mainnet** con una
> instancia propia de TilcAI. Ningún contrato propio tiene auditoría independiente. Las cuentas de
> contrato, los vaults y x402 siguen apagados en mainnet: sus contratos no están desplegados y las
> secciones 1 a 6 describen cómo prepararlos. Los subcomandos `deploy` siguen bloqueados.

## 0. Lo que está en mainnet y cómo se opera

### Contratos propios

| Red | Contrato | Dirección | Estado |
| --- | --- | --- | --- |
| Avalanche C-Chain | `TilcaiCctpRouter` | `0xf6a2EdE00c441863519C6B30A1eb2d04E61847AB` | Desplegado el 2026-10-10 (tx `0x9eb993567b075ee653c53f349217076177d96d3f0c03a82a010c8ed9b4116457`), sin owner ni upgrade |
| Avalanche C-Chain | `TilcaiCctpRouterV2`, `TilcaiAccountFactory`, `TilcaiVault` | — | Sin desplegar |
| Stellar Public Network | `tilcai_account_factory`, `tilcai_vault`, verificadores | — | Sin desplegar |

El router se desplegó desde la cuenta EVM del relayer, con el init code del artefacto compilado
(hash `0xea7cb485e207cda00c9eb5423f99d0ea6f36d69c4acaf95376027bf16d1cd63a`). `npm run mainnet:preflight`
con `CCTP_ROUTER_AVALANCHE_MAINNET` definido compara el código desplegado con el artefacto, byte a
byte fuera de sus `immutable`.

Primer pago real (gasless, 0.01 USDC, comisión CCTP 0, unos 27 s): burn
`0x3bfdc1021f1d1277e7ae05065b157c7346a4f8e072fea4c03ab430ee0b739056` en C-Chain y mint
`cead8c23f46687dc90feba1242a20382756454366fc287f7b66b11ffe10ebbc0` en Stellar.

Segundo pago, ya contra la instancia `tilcai-mainnet` y por su API con `npm run e2e:gasless`
(0.01 USDC, liquidado en 1 min 45 s; el mint tardó 78 s en confirmarse): burn
`0xcfb8bb2d8aa214d09d93ce6ecdb3d2a0883c7a92f8f05ad523173431051c4413` y mint
`43c32917b08c685abeca884188302531eca6a2caad63bdf9a25e81b2bd124821`.

### La instancia

Testnet y mainnet son dos procesos de la misma imagen. Cada uno tiene su base SQLite, sus claves de
API, su puerto y su secreto del tablero; `TILCAI_ENV` elige las redes y un proceso nunca atiende
las dos. La definición está en [`docker-compose.mainnet.yml`](docker-compose.mainnet.yml) y sus
valores en [`.env.mainnet.example`](.env.mainnet.example).

```bash
docker compose -f deploy/docker-compose.mainnet.yml --env-file deploy/.env.mainnet up -d
curl -s http://127.0.0.1:18787/health
```

Para arrancar, mainnet exige: base propia, al menos una clave de API que no sea de testnet, un
relayer por cadena con ids distintos de los de testnet, `CCTP_ROUTER_AVALANCHE_MAINNET`, RPC de
Avalanche y Stellar, Horizon y una cuenta `G…` para simulaciones. El resto son funciones que
quedan apagadas mientras su variable esté vacía: `CCTP_ROUTER_V2_AVALANCHE_MAINNET` y
`ACCOUNT_FACTORY_AVALANCHE_MAINNET` (cuentas; piden además `ERC4337_ENTRYPOINT_AVALANCHE_MAINNET`),
`VAULT_AVALANCHE_MAINNET`, `ACCOUNT_FACTORY_STELLAR_MAINNET`, `VAULT_STELLAR_MAINNET`,
`RELAYER_X402_PLUGIN_ID_MAINNET` y `RELAYER_WEBHOOK_SIGNING_KEY_MAINNET`. Siguen prohibidos en
mainnet `DEV_EVM_PAYER_PRIVATE_KEY`, `STELLAR_OPERATOR_SECRET` y `QR_MOCK_ENABLED`: los modos
`dev_signer` y `dev_gasless` no existen ahí, y quien paga firma en su propia billetera.

`MAINNET_TRANSACTIONS_ENABLED=false` deja la instancia en solo lectura (cotiza y consulta; no crea
pagos). Con `true` mueve fondos reales.

### El relayer

Un mismo OpenZeppelin Relayer puede atender los dos entornos: lo que los separa es el id de
relayer, que fija la red y la cuenta que firma. Es la configuración en uso (relayers
`avalanche-relayer` y `stellar-relayer`), y tiene costos que conviene conocer:

- La clave del firmante es la misma que en testnet. La recomendación de la sección 1 sigue siendo
  un relayer propio con firmantes independientes (`--profile relayer` en el Compose).
- No hay `whitelist_receivers`: quien tenga la clave de la API del relayer puede hacerle enviar
  cualquier transacción y gastar su AVAX y XLM. El relayer no custodia USDC de usuarios.
- Sus avisos por webhook no llegan a la instancia de mainnet: los pagos avanzan igual por sondeo,
  y el tablero no muestra eventos `relayer.*` de mainnet.

El relayer paga el gas: unos 0.006 AVAX y 0.015 XLM por pago. El tablero avisa cuando baja.

### Probar de extremo a extremo

`npm run e2e:gasless` hace un pago contra una instancia en marcha por su API, como lo haría un
tercero: la clave de quien paga queda en el proceso de la prueba y TilcAI solo recibe la firma.

```bash
E2E_API_URL=http://127.0.0.1:18787 E2E_API_KEY=… E2E_PAYER_PRIVATE_KEY=0x… \
  npm run e2e:gasless -- --amount 0.01 --to G…
```

En mainnet mueve USDC reales. La cuenta que paga no necesita AVAX; el destino necesita una
trustline de USDC.

### Tablero

`tilcai-web` muestra un bloque por backend, con mainnet primero y etiquetado como fondos reales.
Acepta los eventos de mainnet solo con `MONITOR_INGEST_SECRET_MAINNET`, que es el
`MONITOR_WEB_SECRET_MAINNET` de la instancia y no puede repetir el de testnet.

### Pendiente

- Auditoría independiente de Solidity y Soroban.
- Desplegar y verificar los demás contratos (secciones 5 y 6) para encender cuentas y vaults.
- Relayer propio de mainnet con firmantes independientes, `whitelist_receivers` y webhooks.
- RPC administrados con SLA, y reemplazar SQLite antes de operar con volumen (sección 8).

## 1. Prerrequisitos y separación

- Revisión/auditoría independiente de Solidity y Soroban, con hallazgos críticos cerrados.
- Node.js 22.16+, dependencias con `npm ci`, Foundry, Stellar CLI y Rust con
  `wasm32v1-none` en las versiones aprobadas.
- RPC privados o administrados para Avalanche C-Chain, Soroban RPC y Horizon, con SLA y
  límites conocidos. Los endpoints públicos son adecuados para preflight, no una decisión
  productiva.
- Direcciones públicas aprobadas para deployer, owner y operator. El deployer no debe quedar
  como owner definitivo. Las identidades EVM y Stellar del Relayer deben ser distintas entre sí
  y de Testnet.
- Un commit exacto del fork del OpenZeppelin Relayer en `RELAYER_REF`; `main` y otras ramas
  mutables son rechazadas por `deploy/build.sh`.
- Gestor de secretos y KMS/HSM o firmante remoto aprobados. Los keystores locales del ejemplo
  son una interfaz transitoria, no la arquitectura productiva recomendada.

No se comparten con Testnet proyectos Compose, puertos, bases SQLite, volúmenes Redis, claves de
API, webhooks ni IDs de relayer. Los firmantes tampoco deberían compartirse; la instalación actual
lo hace (sección 0, «El relayer»). La plantilla es
[`docker-compose.mainnet.yml`](docker-compose.mainnet.yml) y sus valores están documentados en
[`.env.mainnet.example`](.env.mainnet.example).

## 2. Contratos oficiales que se reutilizan

No se despliegan ni se modifican:

| Red | Contrato | Dirección |
| --- | --- | --- |
| Avalanche C-Chain | USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Avalanche C-Chain | Circle TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| Avalanche C-Chain | Circle MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Stellar Public Network | USDC SAC | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| Stellar Public Network | TokenMessengerMinter | `CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL` |
| Stellar Public Network | MessageTransmitter | `CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV` |
| Stellar Public Network | CctpForwarder | `CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T` |

Las constantes viven una sola vez en `src/config/networks.ts`. El preflight comprueba código o
instancia de contrato mediante lecturas. La dirección de EntryPoint v0.9 permanece `PENDING`
hasta aprobar una dirección y comprobar su bytecode en C-Chain.

## 3. Comandos sin efectos blockchain

Estos comandos no tienen un firmante ni una ruta de broadcast:

```bash
npm run mainnet:preflight -- --offline       # configuración, artefactos, herramientas y Relayer
npm run mainnet:preflight                    # añade lecturas RPC/Horizon
npm run mainnet:avalanche -- dry-run \
  --deployer 0xPUBLICA --owner 0xPUBLICA --operator 0xPUBLICA \
  --max 100 --daily 1000 --nonce NONCE_LEIDO
contracts/soroban/deploy-mainnet.sh dry-run \
  --deployer GPUBLICA --owner GPUBLICA_O_CPUBLICO --operator GPUBLICA_O_CPUBLICO \
  --max 100 --daily 1000
```

`mainnet:preflight` distingue `PASS`, `FAIL` y `PENDING`. Un chequeo sin acceso o sin dato nunca
se transforma en `PASS`. `dry-run` EVM codifica init code, argumentos, hashes y direcciones
esperadas a partir de un nonce leído; no crea wallet. El plan Stellar valida artefactos, roles y
límites y calcula hashes locales; no invoca `stellar contract upload/deploy/invoke`.

Los subcomandos `deploy` de ambos preparadores terminan inmediatamente con error. Para habilitar
un despliegue futuro será necesario revisar y cambiar código, lo que fuerza una aprobación nueva.

## 4. Compilación local

Compilar no transmite transacciones:

```bash
cd contracts/evm && forge build && forge test
cd contracts/soroban && stellar contract build && cargo test
```

Guardar junto a la aprobación: commit del repositorio, versión de compilador, lockfiles, hash
SHA-256 de cada WASM, init-code hash y runtime-bytecode hash EVM. No compilar desde un árbol con
cambios no revisados. `TilcaiCctpRouter.sol` procede del commit histórico
`6f0671c52f50577e5345cd825074eec101b77d12`; el dry-run muestra además el hash del archivo actual
para detectar divergencias.

## 5. Orden futuro en Avalanche

Cuando exista aprobación explícita y un mecanismo de firma productivo:

1. Desplegar `TilcaiCctpRouter(USDC, TokenMessengerV2)`.
2. Desplegar `TilcaiCctpRouterV2(USDC, TokenMessengerV2)`.
3. Desplegar `TilcaiAccountFactory()`; su constructor crea la implementación de cuenta.
4. Desplegar `TilcaiVault(USDC, owner, operator, maxPerDisbursement, dailyLimit)`.

Los routers y la factory no tienen owner ni upgrade. El vault sí: `owner` debe ser la gobernanza
aprobada, `operator` el relayer EVM, y nunca se presupone que sean el deployer. Después de cada
recibo se comprueban chain ID 43114, dirección esperada por nonce, runtime bytecode, argumentos
inmutables/getters y código fuente verificado. Antes de usar la factory se valida su
`implementation()` y el EntryPoint que devuelve la implementación.

## 6. Orden futuro en Stellar

Passphrase obligatoria: `Public Global Stellar Network ; September 2015`.

1. Subir `tilcai_account.wasm` y registrar el hash WASM devuelto.
2. Desplegar el verificador Ed25519.
3. Desplegar el verificador WebAuthn/P-256.
4. Desplegar `tilcai_account_factory` con el hash y ambos IDs de verificador.
5. Desplegar `tilcai_vault` con USDC SAC, owner, operator y límites atómicos de 7 decimales.

Después se leen de la factory `account_wasm_hash`, `ed25519_verifier` y
`webauthn_verifier`; del vault se leen `usdc`, `owner`, `operator`, pausa y límites. Los hashes
local/remoto deben coincidir. Factory y vault extienden TTL de instancia aproximadamente de 30 a
90 días al usarse; los registros persistentes del vault se extienden hacia el TTL máximo. Antes
del despliegue real se debe simular cada operación para presupuestar CPU, memoria, rent, TTL y fee,
y comprobar reserva mínima/saldo XLM del source sin crear ni fondear cuentas desde este proceso.

## 7. Relayer y x402

`deploy/relayer/config/config.mainnet.json` define IDs y firmantes separados, webhook firmado,
plugin `x402-mainnet`, `eip155:43114` y `stellar:pubnet`. Ambos relayers empiezan pausados. El EVM
tiene cap de gas, estimación EIP-1559 y umbral de saldo; Stellar tiene estrategia de pago por el
relayer y umbral en stroops. La API conserva Bearer auth y el Compose limita la tasa y publica
solo en loopback.

Antes de despausar se debe agregar una `whitelist_receivers` EVM con únicamente routers, factory
y vault verificados. No puede escribirse antes de conocer esas direcciones. La versión actual no
ofrece una política genérica que limite importe USDC por calldata o gasto acumulado: los límites
de desembolso residen en `TilcaiVault`; un límite agregado adicional requiere modificar/auditar el
fork o introducir un proxy de autorización. Esto es un bloqueo, no un control supuesto.

Validar `/supported`, `/verify` y simulaciones con el plugin exacto construido desde el commit
fijado. `/settle` y los endpoints de transacción quedan fuera de la validación sin fondos.
La documentación oficial confirma `stellar:pubnet`; la ruta EVM existente procede del plugin del
fork y permanece `PENDING` hasta que `/supported` del artefacto fijado anuncie `eip155:43114`.

## 8. Docker y datos

La definición Mainnet tiene nombres, volúmenes y puertos propios, y arranca en solo lectura salvo
que `MAINNET_TRANSACTIONS_ENABLED=true` (sección 0). Su relayer propio es opcional
(`--profile relayer`) y se configura con `config.mainnet.json`, que nace con los relayers pausados.

No usar la SQLite/Litestream actual con fondos reales. Un reemplazo por PostgreSQL requiere una
decisión separada: driver y repositorios transaccionales, migraciones versionadas, bloqueo de
filas/leases para workers, idempotencia y constraints equivalentes, backups/PITR, cifrado,
observabilidad, pruebas de concurrencia/recuperación y ensayo de migración/rollback. Impacta
`src/db`, todos los repositorios, composición, despliegue y operación; no se migró silenciosamente
en esta fase.

## 9. Validación sin fondos

Con relayers todavía pausados y API sin rutas transaccionales habilitadas:

1. Ejecutar preflight hasta resolver `FAIL`; documentar cada `PENDING` y su aprobador.
2. Arrancar, en una futura ventana aprobada, el stack aislado sin despausar el relayer.
3. Validar `/health`, `/v1/routes`, autenticación, aislamiento de base, webhooks firmados y
   monitorización. No llamar a pagos, cuentas, vault, `/settle` ni endpoints de transacciones.
4. Comparar direcciones/bytecode/WASM y roles con el acta de despliegue.
5. Ejecutar pruebas de recuperación con datos sintéticos y sin secretos productivos.

## 10. Aprobaciones, acciones con fondos e incidentes

No consumen AVAX/XLM: compilación, tests locales, hashes, dry-run, lectura RPC/Horizon, lectura de
bytecode/estado, validación Compose y consultas de salud. Sí consumen AVAX: los cuatro despliegues
EVM, fondeo de gas del relayer y cualquier transacción posterior. Sí consumen XLM: upload WASM,
despliegues Soroban, rent/reserva/TTL y fondeo del relayer Stellar.

Antes de habilitar transacciones se aprueban auditoría, artefactos, propietarios, operadores,
EntryPoint, límites, presupuesto, KMS/HSM, allowlist, persistencia PostgreSQL, monitorización,
runbooks y ensayo de rollback. El cambio de `MAINNET_TRANSACTIONS_ENABLED` y el despausado de cada
relayer son aprobaciones separadas y posteriores.

Acciones irreversibles: despliegues y uploads no se borran, los contratos no son upgradeables y
una dirección/constructor equivocado exige volver a desplegar. Respuesta a incidentes: mantener
relayers pausados, pausar vault por su owner, revocar API/plugin en el perímetro, rotar firmantes y
claves, preservar Redis/DB/logs, detener workers y reconciliar transacciones on-chain antes de
reanudar. Nunca redeplegar o reintentar a ciegas una operación con estado incierto.
