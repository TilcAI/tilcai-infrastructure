# Despliegue continuo en saul-tilcai-lor

El esquema sigue el manual de Fexpo Backend: GitHub Actions ejecuta lint, typecheck,
unitarios y smoke de la imagen real; publica la misma imagen con SHA y llama por SSH a
un wrapper restringido. El servidor mantiene lock, espera healthchecks y restaura la
imagen anterior si falla el arranque. No revierte migraciones de base de datos.

## Servidor

Debian 13, Docker y Compose; stack en `/srv/tilcai`, `.env` con permisos 600 fuera de Git.
Redis y relayer son dependencias dockerizadas. API y relayer solo publican loopback.
No se configura DNS/proxy público en esta entrega; acceso administrativo por SSH.
La instancia inicial es testnet, con QR bancario real, mock deshabilitado y Banco
Económico como proveedor principal. Esto no habilita pagos blockchain mainnet.

Los secretos DEPLOY_HOST/PORT/SSH_KEY/KNOWN_HOSTS se configuran en GitHub.
Usuario deploy sin grupo docker; clave con forced command y sudo solo al script de
release. El token GHCR del job se pasa por stdin y su configuración temporal se borra.

## Operación

`ssh saul-tilcai-lor` y, en el host, usar `/srv/tilcai`:

```sh
IMAGE_TAG=$(cat .current_tag) docker compose ps
curl -fsS http://127.0.0.1:8787/health
```

Respaldar SQLite y Redis antes de actualizaciones de esquema. Conservar imágenes
anterior/actual. Las claves y signers se provisionan por canal administrativo, nunca en CI logs.
La imagen del relayer se provisiona inicialmente desde la versión existente; comprobar su
referencia inmutable y actualizarla deliberadamente al cambiar dependencias.

## Dependencia privada de Core

Infraestructura depende de Core para IDs, contratos de errores y transiciones de pagos.
Sus fuentes se descargan del repositorio original al construir; no se versionan copias aquí.
CI requiere el secret `CORE_READ_TOKEN`, con permiso Contents:read limitado al repositorio
TilcAI/tilcai-core. No usar un token personal con acceso general. La referencia está fijada
a un commit en el workflow y checkout no persiste las credenciales.

Si falta ese acceso, CI se detiene antes de construir o desplegar y conserva la versión activa.
La eliminación de la copia del árbol actual no borra los commits históricos ni imágenes anteriores.

## Validación del 2 de noviembre de 2026

212 pruebas unitarias, lint y typecheck pasan en GitHub Actions; el smoke construye y arranca
la imagen real. Antes de integrar se emitió un QR bancario real de Bs 0,10 en estado pendiente
con una base temporal; no se simuló depósito ni se realizó pago.

## Smoke remoto reproducible

Desde el checkout local, después de un release saludable:

```sh
ssh saul-tilcai-lor 'docker exec -i tilcai-tilcai-1 node --input-type=module - --real-qr' < scripts/smoke-server.mjs
```

El argumento `--real-qr` crea un QR bancario real de Bs 0,10, verifica PNG e idempotencia,
consulta su estado y lo cancela. Sin ese argumento solo verifica salud, autenticación y
configuración del proveedor. No simula depósitos ni envía fondos.

También se comprobó generación real sin forzar proveedor con configuración mainnet y
base temporal: Banco Económico respondió primero, QR pendiente de Bs 0,10.
Esto valida el adaptador QR, no la disponibilidad de los rieles blockchain mainnet en el nuevo host.

El pipeline omite releases por cambios exclusivos de Markdown. Las dependencias iniciales
se provisionan por administración; los releases actualizan la API por SHA. La salud del stack
exige relayer disponible, QR real y Banco Económico primero.

## Evidencia del primer release remoto

El [run 41482765021](https://github.com/TilcAI/tilcai-infrastructure/actions/runs/41482765021)
completó verify y deploy; instaló la imagen de 22026fa. En el host pasaron salud,
autenticación, Baneco live/principal, generación de Bs 0,10, PNG válido, idempotencia,
consulta de estado y cancelación. Tras reiniciar el contenedor, el QR cancelado persistió
y el relayer continuó disponible. El smoke usa un cuerpo JSON vacío al cancelar.

La API se publica en loopback; no se configuró un dominio HTTPS nuevo ni se probaron
callbacks bancarios públicos o abonos reales. El host ejecuta blockchain testnet y QR
bancario real. La generación con configuración mainnet se probó separadamente en base
temporal; no se habilitaron pagos blockchain mainnet en este host.

## Relayer con Monad — actualización del 3 de noviembre de 2026

El Compose fija `ghcr.io/tilcai/tilcai-relayer` por digest. La imagen anterior del
servidor contenía solo Fuji y Stellar, aunque `deploy/relayer/config/config.json`
ya definía Monad testnet. La nueva capa incluye esa configuración, la red 10143
y su activo x402, sobre el mismo binario OpenZeppelin Relayer 1.8.0. La etiqueta
OCI revision identifica el commit de construcción `2aa49fd4fc5121526af8fd24e1131dfa9586ac98`.
No se habilitan relayers mainnet ni se reutiliza el firmante testnet para mainnet.

Antes del cambio se comprobó la candidata con Redis independiente, sin procesar
las colas de producción. Se respaldaron SQLite, Redis y Compose. Al instalar el
Compose versionado se recreó únicamente `relayer`, con lock de despliegue y
rollback al Compose anterior en caso de fallo de salud o del smoke autenticado.
El API y Redis conservaron sus contenedores y volúmenes.

Verificación reproducible de solo lectura:

```sh
ssh saul-tilcai-lor 'docker exec -i tilcai-tilcai-1 node --input-type=module -' < scripts/smoke-relayer.mjs
```

Exige readiness de Redis/colas/plugins, rechazo 401 sin clave, Fuji/Monad/Stellar
habilitados, balance/estado RPC consultables y Monad anunciado en x402. La consulta
`GET /v1/vault?network=eip155:10143` respondió 200, `operatorIsRelayer=true`,
`paused=false`, 56.28 USDC testnet y cero pendientes; el RPC devolvió chainId 10143.
No se enviaron transacciones en estas pruebas.

Relayer Monad testnet: `0xcc0bbfaffb786c8bb1212c3555b8c6d0b195d6f5`.
Vault Monad testnet: `0xaa9e6460b6ba396c0b84029f347ff71255130c89`.
Los saldos son observaciones del momento de la comprobación, no valores fijos.

Para posteriores builds, usar `deploy/build.sh relayer` con `RELAYER_BASE`
inmutable y `REGISTRY`/`TAG` explícitos; el script añade la revisión Git como
etiqueta OCI. Publicar la imagen, comprobarla y actualizar su digest en este
Compose requiere instalación administrativa. El pipeline de API conserva el
relayer fijado: no lo reconstruye automáticamente con cada release de la API.

El [run de CI/CD 41662701112](https://github.com/TilcAI/tilcai-infrastructure/actions/runs/41662701112)
completó verify y deploy. La API activa quedó en `98a80e15e96562067a927804c9ed7f96da29a0a9`;
el relayer conserva el digest anterior verificado con Monad. Tras el release completo,
los tres contenedores quedaron healthy y el vault Monad volvió a responder HTTP 200.
