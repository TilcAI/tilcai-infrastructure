# Despliegue en contenedores

TilcAI y lo que necesita para funcionar, empaquetado para correr en un host con Docker o en
una plataforma de contenedores (Google Cloud Run, AWS, Azure).

> **Solo testnet.** La configuración sigue rechazando cualquier entorno distinto de `testnet`.

## Piezas

```
                         ┌──────────────────────────── proyecto TilcAI ────────────────────────────┐
 optipagos-backend ─────▶│ tilcai (API + worker) ──▶ relayer (OpenZeppelin + plugin x402) ──▶ Redis │
 (otro proyecto)   ─────▶│        │ SQLite /data            │ keystore del firmante               │
        └────────────────┼────────┼─────────────────────────┘                                      │
          también llama  │        └─▶ réplica opcional (Litestream → bucket)                       │
          al relayer     └──────────────────────────────────────────────────────────────────────────┘
```

| Imagen | Qué lleva | Puerto | Estado |
| --- | --- | --- | --- |
| `tilcai/tilcai` | API Fastify + worker de conciliación (Node 24, `tsx`), `tilcai-core` y Litestream | 8787 | SQLite en `/data` |
| `tilcai/relayer` | OpenZeppelin Relayer v1.8.0 del fork `SaulChoque/openzeppelin-relayer`, el plugin `x402` (`@rodacio/relayer-plugin-x402-facilitator`) y `relayer/config/` | 8080 | En Redis o en memoria |
| `redis:7` | Colas del relayer (siempre) y, opcionalmente, su almacenamiento | 6379 | Volumen o servicio administrado |

Archivos de esta carpeta:

| Archivo | Para qué |
| --- | --- |
| `Dockerfile`, `entrypoint.sh` | Imagen de TilcAI |
| `relayer/Dockerfile`, `relayer/entrypoint.sh` | Capa de TilcAI sobre la imagen del relayer |
| `relayer/config/` | `config.json` (relayers, firmante, plugin) y las redes Avalanche y Stellar. Sin secretos |
| `build.sh` | Construye y, con `PUSH=1`, publica las imágenes |
| `keystore-addresses.mjs` | Muestra las direcciones EVM y Stellar de un keystore, para fondearlas antes de arrancar |
| `docker-compose.yml`, `.env.example` | Las tres piezas en un host |
| `cloud-run/*.yaml` | Servicios de Cloud Run listos para completar |

## Antes de empezar

- **Docker con Compose v2** y unos 8 GiB de RAM asignados a Docker (la compilación del relayer
  funcionó con 7,4 GiB).
- **Un shell Bash.** En Windows usa Git Bash. El repositorio trae un `.gitattributes` que
  fuerza LF en los `.sh` y los Dockerfile: con CRLF (el valor por defecto de Git for Windows)
  los dos contenedores no arrancan y fallan con
  `exec /app/relayer-entrypoint.sh: no such file or directory`. Si clonaste antes de tener ese
  archivo, regenera `deploy/` con `git ls-files deploy | xargs rm -f && git checkout -- deploy`.
- **`tilcai-core`** clonado junto a este repositorio (`../tilcai-core`).
- **Node 24 y `npm ci`** en este repositorio (para `npm run relayer:check` y
  `deploy/keystore-addresses.mjs`).
- **Cuentas de testnet con fondos**: ver [Crear el keystore y fondear las cuentas](#crear-el-keystore-y-fondear-las-cuentas).
- **Tiempo**: la primera construcción del relayer compila Rust y tardó **33 min** en un equipo
  de 12 CPU y 7,4 GiB (Windows 11, Docker Desktop). Las siguientes reutilizan la caché.

## Construir

```sh
./deploy/build.sh                      # tilcai/tilcai:local y tilcai/relayer:local
```

TilcAI se construye con `tilcai-core` al lado de este repositorio (`../tilcai-core`, o
`TILCAI_CORE_DIR`). El relayer se compila desde el fork (`RELAYER_SOURCE`, `RELAYER_REF`): la
primera vez tarda **más de media hora** porque compila Rust. La primera construcción deja la
base como `tilcai/oz-relayer-base:local`; `RELAYER_BASE=<imagen>` la reutiliza y reconstruir
solo las capas de TilcAI tarda segundos:

```sh
RELAYER_BASE=tilcai/oz-relayer-base:local ./deploy/build.sh
```

Para un registro:

```sh
REGISTRY=us-central1-docker.pkg.dev/MI_PROYECTO/tilcai TAG=$(git rev-parse --short HEAD) \
  PUSH=1 ./deploy/build.sh
```

La imagen del relayer se compila con `redis-tls-rustls`, así acepta `rediss://` (Redis
administrado con TLS). `RELAYER_FEATURES=""` la compila sin TLS.

## Configuración y secretos

Ninguna imagen lleva secretos. Todo entra por variables de entorno.

**Relayer**

| Variable | Secreto | Notas |
| --- | --- | --- |
| `API_KEY` | sí | Clave Bearer de la API del relayer, 32 caracteres o más (`openssl rand -hex 32`). En `deploy/.env` se llama `RELAYER_API_KEY`; el compose se la pasa al relayer como `API_KEY` y a TilcAI como `RELAYER_API_KEY` |
| `KEYSTORE_PASSPHRASE` | sí | Contraseña del keystore del firmante (reglas en [Crear el keystore](#crear-el-keystore-y-fondear-las-cuentas)) |
| `KEYSTORE_JSON_B64` | sí | El archivo del keystore en base64 (`base64 -w0 local-signer.json`). Alternativa: montar el archivo en `/app/config/keys/local-signer.json`, legible por el uid 65532 |
| `REDIS_URL` | según el caso | `redis://…` o `rediss://…` |
| `REPOSITORY_STORAGE_TYPE` | no | `in-memory` (por defecto) o `redis` |
| `STORAGE_ENCRYPTION_KEY` | sí | Solo con `redis`: `openssl rand -base64 32` |
| `PORT` | no | Si la plataforma lo define, el relayer escucha ahí |

El keystore es la identidad on-chain del relayer: sus direcciones pagan el gas (AVAX en Fuji,
XLM en Stellar). **Reutiliza el keystore que ya tiene fondos.** Con uno nuevo hay que fondear
ambas cuentas antes de arrancar: el relayer de Stellar queda deshabilitado mientras su cuenta
no exista en la red. Cómo crearlo y fondearlo, a continuación.

### Crear el keystore y fondear las cuentas

**1. Crear el keystore** con el ejemplo `create_key` del fork del relayer (es la misma
herramienta que usa `tilcai-core/docs/payment-rail-reproducibility.md` §4.1):

```sh
git clone https://github.com/SaulChoque/openzeppelin-relayer.git && cd openzeppelin-relayer
cargo run --example create_key -- --password '<contraseña>' --output-dir keys --filename local-signer.json
```

La contraseña debe tener **12 caracteres o más, con mayúscula, minúscula, número y símbolo**
(`--disable-password-check` lo omite). Un `openssl rand -hex 32` no cumple las reglas. Evita
`$` en la contraseña: Compose lo interpreta al leer `deploy/.env`.

**2. Ver sus direcciones.** El relayer usa los mismos 32 bytes como clave EVM y como semilla
de la cuenta Stellar, así que el keystore controla **dos direcciones**. Obtén ambas antes de
arrancar:

```sh
npm ci
KEYSTORE_PASSPHRASE='<contraseña>' node deploy/keystore-addresses.mjs keys/local-signer.json
# EVM (Avalanche Fuji, needs AVAX): 0x…
# Stellar (testnet, needs XLM)    : G…
```

**3. Fondear.** Importes medidos en la QA del 8 de octubre de 2026:

| Cuenta | Qué necesita | Cuánto | Cómo |
| --- | --- | --- | --- |
| Firmante, dirección **Stellar** | XLM | Lo que da Friendbot (10 000 XLM) | `curl "https://friendbot.stellar.org/?addr=G…"` |
| Firmante, dirección **EVM** | AVAX de Fuji | 0,1 AVAX sobra: un burn gasless cuesta unos 6·10⁻¹¹ AVAX con el gas actual de Fuji | Faucet de Avalanche Fuji |
| Pagador de pruebas (`DEV_EVM_PAYER_PRIVATE_KEY`) | USDC de Fuji | 0,1 USDC por pago | <https://faucet.circle.com> (red Avalanche Fuji) |
| Pagador, solo en los modos `external` y `dev_signer` | AVAX de Fuji | 0,01 AVAX (el `approve` y el burn los paga el pagador) | Faucet de Avalanche Fuji |
| Comercio `payTo` | Cuenta `G…` con trustline a USDC (emisor `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) | — | Friendbot y una operación `changeTrust` |

En los modos gasless el pagador no necesita AVAX: el relayer paga el burn.

**4. Preparar `deploy/.env`.** `KEYSTORE_JSON_B64` es `base64 -w0 keys/local-signer.json`
(en macOS, `base64 -b 0`).

`config.json` define dos relayers (`avalanche-fuji-relayer`, `stellar-example`) con el mismo
firmante y el plugin `x402` para `eip155:43113` y `stellar:testnet`. Otras redes se añaden
ahí y en `relayer/config/networks/`.

**TilcAI**

| Variable | Secreto | Notas |
| --- | --- | --- |
| `TILCAI_API_KEYS` | sí | Claves Bearer aceptadas, separadas por comas (`openssl rand -hex 32`). Vacía, la API solo responde desde dentro del propio contenedor: en un despliegue hay que definirla |
| `RELAYER_URL` | no | URL del relayer |
| `RELAYER_API_KEY` | sí | La misma `API_KEY` del relayer |
| `CCTP_ROUTER_FUJI` | no | `TilcaiCctpRouter` desplegado; habilita los modos gasless |
| `LITESTREAM_REPLICA_URL` | no | `gcs://bucket/ruta`, `s3://bucket/ruta` o `abs://…`. Vacía, la base vive solo en `/data` |
| `TILCAI_ROLE` | no | `all` (por defecto): API y worker en un proceso. `api` y `worker` por separado solo tienen sentido en un mismo host y compartiendo el volumen `/data`; en Cloud Run usa `all` |
| `PORT` | no | Si la plataforma lo define, la API escucha ahí |

Al contenedor de TilcAI solo llegan las variables que lista `environment:` en
`docker-compose.yml` (las de la tabla, más `RELAYER_STELLAR_ID`, `RELAYER_FUJI_ID`,
`RELAYER_X402_PLUGIN_ID`, `STELLAR_*` y `DEV_EVM_PAYER_PRIVATE_KEY`). El archivo
`--env-file deploy/.env` solo rellena esos huecos: **`WORKER_POLL_MS`, `QUOTE_TTL_SECONDS`,
`EVM_MIN_CONFIRMATIONS`, `RPC_*` e `IRIS_API_URL` no se reenvían** aunque los escribas ahí.
Para cambiarlos usa un `docker-compose.override.yml` junto al compose:

```yaml
services:
  tilcai:
    environment:
      WORKER_POLL_MS: "15000"
      RPC_AVALANCHE_FUJI: https://api.avax-test.network/ext/bc/C/rpc
```

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml --env-file deploy/.env up -d
```

## Un host con Docker Compose

Es la forma probada de punta a punta y la más simple para la arquitectura actual.

```sh
cp deploy/.env.example deploy/.env       # completar los secretos
./deploy/build.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d

curl http://127.0.0.1:8787/health        # {"ok":true,"env":"testnet","relayer":"up"}
```

Los puertos 8080 (relayer) y 8787 (TilcAI) quedan en `127.0.0.1`. Para exponerlos, pon
delante un proxy con TLS. Los datos viven en los volúmenes `tilcai-data` (SQLite) y
`redis-data`.

## Google Cloud Run

Dos servicios en un proyecto propio de TilcAI: `tilcai-relayer` y `tilcai`. Ambos necesitan
**una sola instancia siempre encendida y con CPU permanente** (`--min-instances=1
--max-instances=1 --no-cpu-throttling`), porque trabajan en segundo plano aunque no haya
peticiones. Cloud Run no cobra por petición en ese modo sino por instancia encendida.

### 1. Proyecto, registro y secretos

```sh
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create tilcai --repository-format=docker --location=REGION
gcloud auth configure-docker REGION-docker.pkg.dev

REGISTRY=REGION-docker.pkg.dev/PROJECT_ID/tilcai TAG=v1 PUSH=1 ./deploy/build.sh

openssl rand -hex 32 | tr -d '\n' | gcloud secrets create relayer-api-key --data-file=-
printf '%s' "$KEYSTORE_PASSPHRASE" | gcloud secrets create relayer-keystore-passphrase --data-file=-
base64 -w0 local-signer.json | gcloud secrets create relayer-keystore-b64 --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create tilcai-api-keys --data-file=-

gcloud iam service-accounts create tilcai-relayer
gcloud iam service-accounts create tilcai
for sa in tilcai-relayer tilcai; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$sa@PROJECT_ID.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done
```

### 2. Redis

El relayer no arranca sin Redis. Dos caminos:

- **Contenedor acompañante** (lo que hace `cloud-run/relayer.service.yaml`): Redis en la
  misma instancia, en memoria. Sin costo extra y sin red privada. Lo que se pierde en un
  reinicio es lo mismo que hoy con `REPOSITORY_STORAGE_TYPE=in-memory`: el historial de
  transacciones del relayer. TilcAI lo tolera (el mint es idempotente por el nonce de CCTP);
  quien consulte al relayer por el id de una transacción anterior al reinicio recibirá un 404.
- **Redis administrado** (Memorystore, Upstash…): quita el contenedor `redis`, apunta
  `REDIS_URL` al servicio y usa `REPOSITORY_STORAGE_TYPE=redis` con `STORAGE_ENCRYPTION_KEY`.
  El relayer conserva relayers, firmante cifrado e historial entre reinicios. Memorystore
  solo es alcanzable por red privada: añade `--network`/`--subnet` (salida directa a VPC) al
  servicio. Con `redis` el `config.json` se lee solo en el primer arranque; para volver a
  cargarlo, `RESET_STORAGE_ON_START=true` una vez.

### 3. Relayer

```sh
# completar PROJECT_ID, REGION y TAG en el archivo
gcloud run services replace deploy/cloud-run/relayer.service.yaml --region REGION
gcloud run services add-iam-policy-binding tilcai-relayer --region REGION \
  --member=allUsers --role=roles/run.invoker
```

El servicio queda público a nivel de red y protegido por `API_KEY`: ni TilcAI ni
optipagos-backend envían tokens de identidad de Google, así que no pueden pasar el control
de acceso de Cloud Run. Solo `/api/v1/health` y `/api/v1/ready` responden sin clave.

### 4. TilcAI

```sh
gcloud storage buckets create gs://BUCKET --location=REGION --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://BUCKET \
  --member="serviceAccount:tilcai@PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin

# completar PROJECT_ID, REGION, TAG, BUCKET y RELAYER_URL en el archivo
gcloud run services replace deploy/cloud-run/tilcai.service.yaml --region REGION
gcloud run services add-iam-policy-binding tilcai --region REGION \
  --member=allUsers --role=roles/run.invoker
```

El disco de Cloud Run se borra en cada reinicio. Con `LITESTREAM_REPLICA_URL` el contenedor
restaura la base desde el bucket al arrancar y replica cada cambio mientras corre. Litestream
toma las credenciales de la cuenta de servicio.

Límites que conviene conocer antes de elegir Cloud Run para TilcAI:

- **Una instancia, nunca más.** Dos instancias serían dos workers y dos copias de la base.
- **Al publicar una revisión nueva**, Cloud Run enciende la instancia nueva antes de apagar
  la anterior. Durante esos segundos conviven dos: lo que la anterior escriba después de que
  la nueva restauró no llega a la nueva. Publica sin pagos en curso.
- **Una caída brusca** puede perder hasta el último segundo de escrituras (el intervalo de
  réplica).
- Un volumen de Cloud Storage montado no sirve para SQLite (no tiene bloqueos de archivo).

Si esos límites pesan, una VM pequeña con el `docker-compose.yml` y disco persistente es más
sólida para esta arquitectura. La solución de fondo es llevar el almacenamiento de TilcAI a
Postgres, que es un cambio de código y no de despliegue.

## AWS y Azure

Las mismas imágenes y variables; cambia el nombre de cada pieza.

| Necesidad | Google Cloud | AWS | Azure |
| --- | --- | --- | --- |
| Registro | Artifact Registry | ECR | Container Registry |
| Contenedores siempre encendidos | Cloud Run (CPU permanente, 1 instancia) | ECS en Fargate (servicio con `desiredCount: 1`) | Container Apps (`minReplicas: 1`, `maxReplicas: 1`) |
| Secretos | Secret Manager | Secrets Manager (`secrets` en la definición de tarea) | Secretos de Container Apps o Key Vault |
| Redis | Memorystore, o contenedor acompañante | ElastiCache, o contenedor en la misma tarea | Azure Cache for Redis, o contenedor en la misma app |
| Disco para SQLite | No hay: Litestream a `gcs://` | Volumen EFS en `/data`, o Litestream a `s3://` | Azure Files en `/data`, o Litestream a `abs://` |

- **App Runner (AWS) no sirve** para estas piezas: reduce la CPU fuera de las peticiones y no
  admite contenedores acompañantes.
- En ECS, relayer y Redis pueden ir en una misma tarea (comparten `localhost`), igual que en
  el manifiesto de Cloud Run.
- SQLite sobre discos de red (EFS, Azure Files) funciona con una sola instancia, pero es más
  lento y delicado que un disco local. Litestream es la opción equivalente en las tres nubes.
- Con ElastiCache o Azure Cache usa `rediss://` (la imagen ya incluye TLS).

## Conectar optipagos-backend

El backend de Optipagos vive en otro proyecto y habla con las dos piezas:

```bash
RELAYER_URL=https://<url del servicio tilcai-relayer>
RELAYER_API_KEY=<API_KEY del relayer>
RELAYER_EVM_ID=avalanche-fuji-relayer
TILCAI_API_URL=https://<url del servicio tilcai>
TILCAI_API_KEY=<una de TILCAI_API_KEYS>
TILCAI_ROUTER_ADDRESS=0x297ce6a2787484db4bB18A96a8F28A9881Fc163C
```

## Qué está probado

Probado en local con Docker (5 de octubre de 2026), con un keystore desechable:

- `build.sh` construye las dos imágenes (la del relayer, reutilizando una base ya compilada).
- El stack de `docker-compose.yml` arranca y queda sano: los dos relayers cargados, el plugin
  `x402` responde `/supported`, TilcAI se autentica contra el relayer y crea cotizaciones.
- Ambas APIs rechazan peticiones sin clave (401).
- El relayer con `REPOSITORY_STORAGE_TYPE=in-memory` y con `redis` (conserva su estado al
  reiniciar).
- Las dos imágenes escuchan en `$PORT` y terminan limpio con SIGTERM en menos de un segundo.
- El relayer se niega a arrancar sin keystore, con un mensaje claro.
- TilcAI restaura su base con Litestream al arrancar con el disco vacío (réplica `file://`).
- `TILCAI_ROLE=api` y `TILCAI_ROLE=worker` arrancan y se detienen limpio. El worker suelto se
  cerraba nada más arrancar: quedó corregido en `src/apps/worker/main.ts`.
- El relayer acepta el keystore montado como archivo en lugar de la variable.

Reproducido por un segundo integrante desde cero (8 de octubre de 2026, commit `289c0e4`,
Windows 11 + Docker Desktop, keystore nuevo), con pagos reales de 0,1 USDC Fuji → Stellar a
través de las imágenes:

- `GET /health` → `relayer: "up"`; con el relayer parado pasa a `down` y vuelve en ~8 s.
  `npm run relayer:check` pasa (6 de 6).
- Pago `dev_gasless` por HTTP hasta `SETTLED`, y pago `external` (la wallet difunde `approve`
  y burn, y se envía el hash a `/burn`) hasta `SETTLED`.
- **Durabilidad**: el contenedor `tilcai` detenido (corte brusco o `SIGTERM`) en
  `BURN_SUBMITTED`, en `ATTESTED`, en `MINT_SUBMITTED` y justo después de que el relayer
  aceptara el mint (antes de que TilcAI lo anotara). En los cuatro casos el pago terminó
  `SETTLED` con un solo mint.
- **Relayer caído** con el pago en `ATTESTED`: el pago espera sin perder estado y se liquida
  al volver el relayer (tarda ~1 min más por la guarda de 60 s ante envíos ambiguos).
- **Persistencia**: `docker compose down` + `up -d` conserva pagos, eventos y recibos.
- Idempotencia (`Idempotency-Key`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE`) y rechazo de un burn
  que ya respalda otro pago.

## Problemas conocidos

- **Reiniciar el relayer con un pago en vuelo deja el pago atascado** si el relayer usa
  `REPOSITORY_STORAGE_TYPE=in-memory` (el valor por defecto). Tras el reinicio el relayer no
  conoce el id de la transacción de mint, responde `404` y TilcAI lo reintenta indefinidamente
  sin reenviar el mint (observado durante más de 7 minutos con el pago en `MINT_SUBMITTED`; el
  nonce CCTP seguía sin usar y el `payTo` sin recibir). **Mitigación verificada:**
  `REPOSITORY_STORAGE_TYPE=redis` con `STORAGE_ENCRYPTION_KEY`; con ese ajuste el mismo
  reinicio termina en `SETTLED`. Recuperación manual de un pago ya atascado: comprobar con
  `is_nonce_used` que el nonce sigue libre y devolver el pago a `ATTESTED`. El mint es
  idempotente por el nonce.
- **Un pago `SETTLED` por recuperación («nonce already used») no tiene `mintTxHash`** ni
  enlace de mint, y el recibo trae `destination.txHash: null`. El mint existe en la cadena y
  en el historial del relayer.
- **Los modos `gasless` y `dev_gasless` no comprueban el saldo del pagador.** Con un pagador
  sin USDC el relayer difunde, y paga el gas de, burns que revierten, uno cada ~10 s hasta que
  vence la autorización (53 en 10 min, para un solo pago).
- **La imagen del relayer puede no arrancar** con `libssl.so.4: cannot open shared object
  file`: `Dockerfile.production` del fork instala `openssl-dev` sin fijar versión y la
  etapa final solo copia `libssl.so.3`. Hasta que se corrija en el fork, añade `openssl-4.0` a
  la base ya compilada y reconstruye con `RELAYER_BASE`:

  ```dockerfile
  FROM tilcai/oz-relayer-base:local
  USER root
  RUN apk add --no-cache openssl-4.0
  USER nonroot
  ```

  ```sh
  docker build -t tilcai/oz-relayer-base:fixed .
  RELAYER_BASE=tilcai/oz-relayer-base:fixed ./deploy/build.sh relayer
  ```

Sin probar:

- **Nada se ha desplegado en Google Cloud, AWS ni Azure.** Los manifiestos de `cloud-run/` y
  los comandos de esta guía no se han ejecutado contra una cuenta real.
- Litestream contra `gcs://`, `s3://` o `abs://`.
- El relayer contra un Redis con TLS (`rediss://`).
- Reiniciar el relayer con un pago en `AWAITING_BURN` en los modos gasless (por el código,
  `stepAwaitingBurn` trata el `404` igual que el mint).
- La conducta cuando el `payTo` pierde su trustline después del burn (`PAYTO_TRUSTLINE_MISSING`).
