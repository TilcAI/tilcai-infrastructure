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
