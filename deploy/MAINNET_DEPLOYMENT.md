# Preparación de despliegue Mainnet

> Estado: **Fase 2, preparación solamente**. Los contratos propios no están auditados y los
> relayers Mainnet están configurados con `paused: true`. No habilitar transacciones ni usar
> fondos reales. Esta guía no autoriza ningún despliegue.

## 1. Prerrequisitos y separación

- Revisión/auditoría independiente de Solidity y Soroban, con hallazgos críticos cerrados.
- Node.js 22.20+ o 24 LTS; la imagen Docker usa Node 24. En este equipo 22.16 falla en
  pruebas SQLite de cuentas. Dependencias con `npm ci`, Foundry, Stellar CLI y Rust con
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
API, webhooks, firmantes ni IDs de relayer. La plantilla es
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
instancia de contrato mediante lecturas; la mera existencia no demuestra identidad, versión ni
comportamiento. La dirección de EntryPoint v0.9 permanece `PENDING`
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

En PowerShell, si `npm run` no reenvía `--offline` al proceso, usar directamente
`.\node_modules\.bin\tsx.cmd src/apps/cli/mainnet-preflight.ts --offline` y comprobar que
la salida indique `OFFLINE_READ_ONLY`. Sin `--offline` se intentan lecturas de red.

`mainnet:preflight` distingue `PASS`, `FAIL` y `PENDING`. Un chequeo sin acceso o sin dato nunca
se transforma en `PASS`. Cuando se han proporcionado todas las variables obligatorias, valida
también el esquema completo de Mainnet; el rechazo informa nombres de campos, no valores.
La compatibilidad real de la sobrecarga ERC-1271 de USDC sigue `PENDING` hasta probarla mediante
simulación de solo lectura en un fork con una firma aprobada; buscar un selector en bytecode
de un proxy no es prueba suficiente. `dry-run` EVM codifica init code, argumentos, hashes y direcciones
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

La definición Mainnet tiene `restart: "no"`, nombres/volúmenes/puertos propios y fija
`MAINNET_TRANSACTIONS_ENABLED=false`. No debe ejecutarse todavía. Para una revisión sintáctica
sin proporcionar secretos ni habilitar el stack:

```bash
docker compose -f deploy/docker-compose.mainnet.yml config --no-interpolate --quiet
```

La plantilla `.env.mainnet.example` deja vacías deliberadamente las credenciales, direcciones
propias, endpoints por aprobar y el tag de imagen. Una interpolación normal de Compose debe
fallar mientras falten estos valores; eso no equivale a un fallo de sintaxis.

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
