# Integración con tilcai-core 0.1.0

Rama de revisión: feat/shared-core-contracts. Cambios locales; no es una publicación de
paquetes ni un despliegue. Core conserva private:true hasta acordar registro y visibilidad.
No se copian sus fuentes en los repositorios consumidores ni se incorporan al bundle SDK.

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

## Desarrollo y compilación

Los repositorios conservan la disposición de directorios hermanos y la dependencia local
file:../tilcai-core. Esto permite revisar la integración sin publicar código privado:

```sh
cd ../tilcai-core
npm ci
npm run typecheck
npm test
# Desde el consumidor npm: npm ci, npm run typecheck y npm test.
# Web conserva pnpm y sus versiones del lockfile: pnpm install --frozen-lockfile.
```

La imagen backend compila Core en una etapa de construcción; en runtime copia únicamente
su package.json y dist. El contexto se crea desde el repositorio original, no desde una
copia vendorizada. CI aún necesita CORE_READ_TOKEN de lectura limitada y la revisión Core
compatible fijada en su workflow. No configurar un token amplio para resolver ese acceso.

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

## Distribución posterior

Antes de publicar consumidores fuera de este entorno, acordar acceso al paquete Core y
registro, publicar una versión autorizada de Core y sustituir file:../tilcai-core por una
versión exacta. Verificar empaquetado y compatibilidad de todos los consumidores primero.
No publicar el SDK con una dependencia file a un directorio que el instalador no tendrá.
No activar npm publish ni publicar fuentes privadas como solución provisional.

## Cambios específicos de este proyecto

Backend imports compiled subpaths, keeps provider clients and transactions local, and builds Core before npm ci. Runtime image contains only Core dist/package.json. CORE_READ_TOKEN remains required for the existing private checkout.

`tilcai-core/legacy-sdk` conserva la superficie anterior del SDK, incluida la parte experimental. No es la raíz estable recomendada para integraciones nuevas.

## Verificación local de la integración

Core: 33 tests; backend: 212; SDK: 86; MCP: 7; web: 108. Typecheck pasa en los cinco proyectos de código. Builds Core/SDK/MCP/web y smoke SDK ESM/CJS pasan. La imagen backend arrancó con Core compilado y sin fuentes Core en runtime. No se ejecutaron pagos, operaciones bancarias ni despliegues en servidor. El acceso privado de CI y la distribución por registro requieren configuración autorizada antes de publicar/integrar.
