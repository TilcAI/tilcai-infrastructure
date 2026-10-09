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
| `docker-compose.yml`, `.env.example` | Las tres piezas en un host |
| `cloud-run/*.yaml` | Servicios de Cloud Run listos para completar |

## Construir

```sh
./deploy/build.sh                      # tilcai/tilcai:local y tilcai/relayer:local
```

TilcAI se construye con `tilcai-core` al lado de este repositorio (`../tilcai-core`, o
`TILCAI_CORE_DIR`). El relayer se compila desde el fork (`RELAYER_SOURCE`, `RELAYER_REF`): la
primera vez tarda varios minutos porque compila Rust. `RELAYER_BASE=<imagen>` reutiliza una
base ya compilada.

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
| `API_KEY` | sí | Clave Bearer de la API del relayer, 32 caracteres o más (`openssl rand -hex 32`) |
| `KEYSTORE_PASSPHRASE` | sí | Contraseña del keystore del firmante |
| `KEYSTORE_JSON_B64` | sí | El archivo del keystore en base64 (`base64 -w0 local-signer.json`). Alternativa: montar el archivo en `/app/config/keys/local-signer.json`, legible por el uid 65532 |
| `REDIS_URL` | según el caso | `redis://…` o `rediss://…` |
| `REPOSITORY_STORAGE_TYPE` | no | `in-memory` (por defecto) o `redis` |
| `STORAGE_ENCRYPTION_KEY` | sí | Solo con `redis`: `openssl rand -base64 32` |
| `WEBHOOK_SIGNING_KEY` | sí | Firma los avisos que el relayer envía a TilcAI (`openssl rand -hex 32`). `config.json` la referencia: sin ella el relayer no arranca |
| `PORT` | no | Si la plataforma lo define, el relayer escucha ahí |

El keystore es la identidad on-chain del relayer: sus direcciones pagan el gas (AVAX en Fuji,
XLM en Stellar). **Reutiliza el keystore que ya tiene fondos.** Con uno nuevo hay que fondear
ambas cuentas antes de arrancar: el relayer de Stellar queda deshabilitado mientras su cuenta
no exista en la red.

`config.json` define dos relayers (`avalanche-fuji-relayer`, `stellar-example`) con el mismo
firmante y el plugin `x402` para `eip155:43113` y `stellar:testnet`. Otras redes se añaden
ahí y en `relayer/config/networks/`.

**Avisos del relayer.** Los dos relayers envían sus avisos (cada cambio de estado de una
transacción, un relayer que se deshabilita) a la notificación `tilcai-monitor` de
`config.json`: un webhook a `http://tilcai:8787/v1/webhooks/relayer`, firmado con
`WEBHOOK_SIGNING_KEY`. Esa URL es la de Compose; donde TilcAI tenga otra dirección (Cloud
Run), cámbiala en `config.json` antes de construir la imagen. TilcAI comprueba la firma con
`RELAYER_WEBHOOK_SIGNING_KEY` (el mismo valor) y muestra los avisos en el tablero; nunca
decide un pago por ellos.

**TilcAI**

| Variable | Secreto | Notas |
| --- | --- | --- |
| `TILCAI_API_KEYS` | sí | Claves Bearer aceptadas, separadas por comas (`openssl rand -hex 32`). Vacía, la API solo responde desde dentro del propio contenedor: en un despliegue hay que definirla |
| `RELAYER_URL` | no | URL del relayer |
| `RELAYER_API_KEY` | sí | La misma `API_KEY` del relayer |
| `CCTP_ROUTER_FUJI` | no | `TilcaiCctpRouter` desplegado; habilita los modos gasless |
| `VAULT_FUJI` | no | `TilcaiVault` desplegado; habilita `/v1/vault`. Su operador debe ser la cuenta del relayer `RELAYER_FUJI_ID`. Quien tenga una clave de `TILCAI_API_KEYS` puede pedir pagos hasta los límites del contrato |
| `LITESTREAM_REPLICA_URL` | no | `gcs://bucket/ruta`, `s3://bucket/ruta` o `abs://…`. Vacía, la base vive solo en `/data` |
| `RELAYER_WEBHOOK_SIGNING_KEY` | sí | La `WEBHOOK_SIGNING_KEY` del relayer. Vacía, `/v1/webhooks/relayer` solo acepta avisos sin firmar desde el propio host |
| `MONITOR_WEB_URL` | no | `<tilcai-web>/api/monitor/events`: adonde TilcAI envía sus eventos para el tablero. Vacía, los eventos se quedan en su base (`GET /v1/monitor/events`) |
| `MONITOR_WEB_SECRET` | sí | Firma cada envío; el mismo valor que `MONITOR_INGEST_SECRET` en tilcai-web (`openssl rand -hex 32`) |
| `QR_MOCK_ENABLED` | no | `true` sirve el mock de QR Simple en `/mock/vendis` (API de Vendis y la página «Simular depósito»). No mueve dinero: solo demos |
| `QR_MOCK_EMAIL`, `QR_MOCK_PASSWORD` | sí | Credenciales del `login` del mock |
| `QR_MOCK_CALLBACK_URL` | no | El callback de quien cobra: `<optipagos-backend>/api/v1/devices/simple-qr/callback` |
| `QR_MOCK_PUBLIC_URL` | no | Base de `qr_url` tal como la ve quien llama (`http://tilcai:8787`) |
| `QR_MOCK_SIMULATOR_KEY` | sí | Abre «Simular depósito» desde fuera del contenedor: `/mock/vendis/?key=…`. Dentro de Compose el navegador nunca es «el propio host», así que hace falta |
| `TILCAI_ROLE` | no | `all` (por defecto): API y worker en un proceso. `api` y `worker` por separado solo tienen sentido en un mismo host y compartiendo el volumen `/data`; en Cloud Run usa `all` |
| `PORT` | no | Si la plataforma lo define, la API escucha ahí |

El resto de variables de `.env.example` del repositorio (`RPC_*`, `WORKER_POLL_MS`…) funcionan
igual dentro del contenedor.

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
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create relayer-webhook-signing-key --data-file=-

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

Para la compra de dólares con el QR de TilcAI (mock), además:

```bash
BUY_QR_PROVIDER=tilcai
TILCAI_QR_EMAIL=<QR_MOCK_EMAIL>
TILCAI_QR_PASSWORD=<QR_MOCK_PASSWORD>
```

y en TilcAI, `QR_MOCK_CALLBACK_URL=<url de optipagos-backend>/api/v1/devices/simple-qr/callback`.

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

Añadido el 9 de octubre de 2026 y probado solo fuera de contenedores (`npm start` contra el
relayer local): el mock de QR Simple, los eventos hacia tilcai-web y el receptor de avisos
del relayer, este último con avisos firmados de prueba. **No se ha reconstruido ninguna imagen
con estos cambios**: la notificación `tilcai-monitor` de `config.json` y la variable
`WEBHOOK_SIGNING_KEY` del relayer están sin probar en contenedor.

Sin probar:

- **Nada se ha desplegado en Google Cloud, AWS ni Azure.** Los manifiestos de `cloud-run/` y
  los comandos de esta guía no se han ejecutado contra una cuenta real.
- Litestream contra `gcs://`, `s3://` o `abs://`.
- El relayer contra un Redis con TLS (`rediss://`).
- Un pago completo (burn en Fuji y mint en Stellar) a través de las imágenes: requiere el
  keystore con fondos.
