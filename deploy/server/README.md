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

La organización deshabilita deploy keys y el GITHUB_TOKEN de infraestructura no puede
leer Core. `deploy/vendor/tilcai-core` conserva un snapshot de fuentes del commit indicado
en SOURCE.md. CI lo copia al directorio hermano para respetar la dependencia `file:`.
Al actualizar Core, renovar ese snapshot y ejecutar las suites; no requiere tokens personales.

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
