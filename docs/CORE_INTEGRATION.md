# Integración con tilcai-core 0.1.0

Rama de integración: feat/shared-core-contracts. Core se consume desde su registro privado.

## Superficie del paquete

| Entrada | Responsabilidad |
| --- | --- |
| tilcai-core/contracts | IDs, errores, estados y transiciones de dominio |
| tilcai-core/monitor | Esquema, fuentes, severidades, eventos y entrega del monitor |
| tilcai-core/api | Contratos de credenciales, TypedData y UnsignedCall |
| tilcai-core/networks | Identificadores de red y entorno; sin endpoints ni direcciones de contratos |
| tilcai-core/amount | Conversión decimal/atómica exacta y rescale sin truncamiento |
| tilcai-core/experimental/* | Autoridad, política prototipo y catálogo MCP de dominio |

La raíz estable excluye los módulos experimentales y no importa node:crypto. Core genera
ESM, CommonJS y declaraciones; sus exports no permiten importar src/*.ts. Los consumidores
usan subpaths compilados. El SDK mantiene sus entradas anteriores como reexports externos.

## Instalación del paquete privado

Core 0.1.0 está publicado como `@tilcai/core` en GitHub Packages con visibilidad privada. Este consumidor fija `tilcai-core: npm:@tilcai/core@0.1.0`: el alias conserva los imports existentes y el lock verifica la integridad del paquete. No necesita un clon hermano de Core.

El archivo .npmrc contiene únicamente el registro y la referencia `${NODE_AUTH_TOKEN}`. Para desarrollo, suministrar un PAT classic con read:packages y acceso al paquete mediante el gestor de secretos o el entorno; no guardar la credencial en Git. Ejecutar `npm ci`; web usa `pnpm install --frozen-lockfile`.

En GitHub Packages → core → Package settings → Manage Actions access, conceder **Read** al repositorio consumidor. Los workflows usan `GITHUB_TOKEN` con packages:read (infraestructura conserva packages:write para publicar su imagen). Esta concesión de acceso debe comprobarse en GitHub; editar el workflow no la concede. Los jobs de PR externos se omiten para proteger el código privado.

Para Docker backend, suministrar un archivo npmrc autenticado mediante `NPMRC_FILE=/ruta/segura/npmrc ./deploy/build.sh tilcai`. BuildKit lo monta como secreto; no se copia al contexto ni a la imagen. Si contiene `${NODE_AUTH_TOKEN}`, exportar esa variable en el entorno del comando no basta para expandirla dentro del build: preparar el archivo temporal autenticado desde un gestor de secretos, protegerlo con chmod 600 y eliminarlo al terminar. CI usa el npmrc temporal de setup-node.

SDK y MCP necesitan acceso privado a Core también en el entorno de quien los instala, incluso si se distribuyen públicamente. No son instalables anónimamente con esta dependencia. No se han publicado nuevas versiones de esos consumidores.

## Compatibilidad

- Las reglas SDK para importes positivos, espacios, ceros iniciales y precisión siguen en
  su adaptador. Core contiene la aritmética exacta; backend conserva RangeError y su
  política de cero permitido. SDK corrige atomicToDecimal para tokens de cero decimales.
- Los compromisos de autoridad experimentales conservan stellar:mainnet. El registro
  operativo usa stellar:pubnet. No se normalizan compromisos históricos de forma implícita.
- Monitor mantiene tilcai-monitor-v1, permite tipos futuros como texto y añade al catálogo
  web los cuatro eventos de gateway QR que ya emite el backend.
- La ejecución de pagos, reservas SQLite, RPC, bancos, secretos, transporte y UI continúan
  en sus respectivos consumidores. Una evaluación de política no firma ni paga.

## Cambios específicos de este proyecto

Backend imports compiled subpaths, keeps provider clients and transactions local, and installs the versioned Core package with npm ci. BuildKit mounts credentials as a secret; runtime contains Core inside node_modules.

`tilcai-core/legacy-sdk` conserva la superficie anterior del SDK, incluida la parte experimental. No es la raíz estable recomendada para integraciones nuevas.

## Verificación local de la integración

Core: 33 tests; backend: 212; SDK: 86; MCP: 7; web: 108. Typecheck pasa en los cinco proyectos de código. Builds Core/SDK/MCP/web y smoke SDK ESM/CJS pasan. La imagen backend arrancó con Core compilado y sin fuentes Core en runtime. No se ejecutaron pagos, operaciones bancarias ni despliegues en servidor. El acceso de cada repositorio en Manage Actions access requiere verificación administrativa.

## N-15: identidad Stellar entre autoridad v1 y registro operativo

El contrato de autoridad `tilcai-intent-v1`/`tilcai-mandate-v1` de Core acepta
`stellar:testnet` y `stellar:mainnet`. La red entra literalmente en
`intentCommitment` (`tilcai-intent-commitment-v1`), así que cambiarla antes de
verificar una aprobación produciría otro hash. El registro, la API y las filas
SQLite existentes de Infrastructure usan `stellar:testnet` y `stellar:pubnet`.
El Relayer llama a esta última red `mainnet` en su propio campo `network`; el
plugin x402 anuncia `stellar:pubnet`.

La tabla de frontera `tilcai-stellar-network-compat-v1`, fijada en
`test/fixtures/n15-stellar-network-v1.json`, propone estas equivalencias de
entorno: `stellar:testnet` ↔ `stellar:testnet` y `stellar:mainnet` (Core v1) ↔
`stellar:pubnet` (Infrastructure). `src/config/stellar-network-compat.ts`
implementa solo la resolución explícita de IDs. Rechaza IDs desconocidos y el
alias del otro lado; no cambia objetos firmados, compromisos, filas SQLite ni
las redes activas. El fixture sintético fija un compromiso v1, comprobado
contra `@tilcai/core@0.1.0`. La lectura de una fila SQLite `stellar:pubnet`
conserva el valor original.

**Decisión pendiente de Saúl y Omar:** aceptar el ID operativo canónico y el
alcance de este mapeo para la futura integración MCP. Antes de admitir
`stellar:mainnet` en una API pública de pagos, habrá que versionar esa frontera
y revisar también hashes de solicitudes, idempotencia, respuestas y lectura de
datos históricos. Los parsers de autoridad y compromisos v1 de Core permanecen
intactos hasta acordar cualquier cambio del contrato firmado. El fixture debe
copiarse y probarse en un PR separado de Core basado en su HEAD actualizado;
esta rama todavía no acredita ese gate cruzado.
