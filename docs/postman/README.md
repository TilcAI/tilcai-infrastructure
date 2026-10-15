# Postman: pruebas de la API de TilcAI desde la red local

Archivos:

- `tilcai-api.postman_collection.json`: 33 peticiones en 7 carpetas (salud, pagos crosschain, cuentas,
  QR de cobro, vault, monitor y mock de Vendis). Guardan solas los ids que devuelven (`quoteId`,
  `paymentId`, `qrId`…) para encadenar las siguientes.
- `tilcai-local.postman_environment.json`: `baseUrl` y las claves.

## Uso

1. En Postman: **Import** → los dos archivos; elige el entorno **TilcAI (red local)**.
2. En el entorno: `baseUrl` = `http://<IP-del-servidor>:8787` y `apiKey` = una clave de
   `TILCAI_API_KEYS` (secreta: no la subas a ningún repositorio).
3. Ejecuta **1. Salud y rutas → GET /health**. Si responde `ok: true`, el resto está al alcance.

| Variable | Para qué |
| --- | --- |
| `apiKey` | Clave de operador de `TILCAI_API_KEYS`: pagos, QR, vault, monitor |
| `tenantKey` | Clave de un tenant con `accounts:read/write` (carpeta 3); el operador recibe 403 ahí |
| `payTo` | Cuenta `G…` de Stellar **con trustline a USDC** (cotizaciones) |
| `payerAddress` | Dirección `0x…` del pagador / destino de un desembolso |
| `mockEmail`, `mockPassword`, `simulatorKey` | Carpeta 7, con `QR_MOCK_ENABLED=true` |

## Que el servidor sea alcanzable desde otro dispositivo

Por omisión la API escucha solo en loopback (`API_HOST=127.0.0.1`) y el Compose publica el puerto
en `127.0.0.1`. Para probar desde el teléfono o un portátil de la misma red:

- **Sin Docker:** `API_HOST=0.0.0.0` y `TILCAI_API_KEYS=<clave>` en `.env`. **Sin clave, solo
  responde a loopback**: desde otro equipo todo da 401.
- **Con Docker:** en `deploy/docker-compose.yml`, el puerto de `tilcai` pasa de
  `"127.0.0.1:${TILCAI_PORT:-8787}:8787"` a `"${TILCAI_PORT:-8787}:8787"` (o a la IP LAN del
  servidor) y se define `TILCAI_API_KEYS` en `deploy/.env`. Alternativa sin tocar nada: un túnel
  SSH, `ssh -L 8787:127.0.0.1:8787 usuario@servidor`, y `baseUrl=http://127.0.0.1:8787`.
- Abre el puerto 8787 en el firewall del servidor solo para tu red local.
- La API no usa TLS: la clave viaja en claro por la red. Es para una LAN de confianza; para
  cualquier otra cosa, un proxy con HTTPS delante.
- El **mock de Vendis**: `QR_MOCK_PUBLIC_URL=http://<IP>:8787` para que `qr_url` apunte a una
  dirección que el dispositivo alcance, y `?key=<QR_MOCK_SIMULATOR_KEY>` para abrir el simulador
  desde otro equipo.

## Qué esperar

- Las peticiones que crean recursos llevan `Idempotency-Key: {{$guid}}`: una por envío. Para
  comprobar la idempotencia, fija la llave a mano y repite: `201` la primera vez, `200` después.
- `Crear pago`, `Enviar firma` y `Avisar burn` mueven dinero de testnet: los valores de ejemplo
  (`0x000…`) solo sirven para ver la validación; para un pago real usa `dev_gasless` (testnet, clave
  de desarrollo del servidor) o firma `authorization.typedData` con tu billetera.
- `Emitir QR` llama a los sandbox de Banco Económico / ATC y muestra la imagen del QR en la
  pestaña **Visualize**.
- Verificado el 2026-10-15 contra una instancia local por IP LAN con clave: `/health`, `/v1/routes`,
  `/v1/qr/providers`, `POST /v1/qr` (QR de Baneco emitido), `/v1/monitor/events`, y la validación
  de `/v1/crosschain/quotes`.
