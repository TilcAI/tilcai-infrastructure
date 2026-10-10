# TilcAI Infrastructure — Fase 2: Preparación de despliegues Mainnet

Continúa la migración de TilcAI a Mainnet en la rama actual `feat/mainnet-support`.

La Fase 1 ya está implementada y he ejecutado las pruebas manualmente desde Windows PowerShell.

## ESTADO CONFIRMADO

- Node.js v22.20.0.
- npm 10.9.3.
- `../tilcai-core` ya fue clonado.
- `npm ci` finalizó correctamente.
- `npm run typecheck`: PASS.
- `npm test`: 179/180 pruebas aprobadas.
- Las 5 pruebas nuevas de selección y seguridad Mainnet pasaron.
- El único test fallido es el existente en `repository-sqlite.test.ts`, relacionado con cuatro subprocesos y un resultado `NaN`. No pertenece a los cambios implementados en Fase 1. Regístralo como pendiente, sin ocultarlo ni modificarlo salvo que sea imprescindible.

El objetivo NO es repetir la auditoría anterior.

Quiero implementar todo lo necesario para dejar preparados los despliegues de TilcAI a Avalanche Mainnet y Stellar Mainnet, pero SIN ejecutarlos todavía.

## 1. REGLAS DE SEGURIDAD

Antes de modificar:

1. Comprueba que estás en `feat/mainnet-support`.
2. Conserva íntegramente los cambios de Fase 1.
3. No elimines archivos ni normalices masivamente CRLF/LF.
4. No realices `reset --hard`, `clean`, `pull`, merge ni rebase sin autorización.
5. No modifiques servicios, contenedores Docker o bases de datos en funcionamiento.
6. No uses claves privadas reales.
7. No generes wallets ni firmes transacciones.
8. No despliegues contratos.
9. No envíes transacciones blockchain.
10. No hagas commit ni push.

Puedes modificar código, configuraciones de ejemplo, scripts, documentación y pruebas.

## 2. SCRIPTS DE DESPLIEGUE AVALANCHE MAINNET

Actualmente existen scripts CLI destinados a Fuji:

- `src/apps/cli/sca.ts`
- `src/apps/cli/vault.ts`

Y contratos propios dentro de `contracts/evm/`.

Quiero preparar un mecanismo de despliegue específico y seguro para Avalanche Mainnet, incluyendo los contratos que efectivamente requiere la arquitectura actual:

- `TilcaiCctpRouter`
- `TilcaiCctpRouterV2`
- `TilcaiAccountFactory`
- `TilcaiVault`

Revisa también el repositorio o artefacto original relacionado con `TilcaiCctpRouter`, para identificar su código fuente exacto y no inventar ni recrear un contrato diferente.

REQUISITOS:

- Validar chain ID 43114.
- Utilizar USDC oficial de Avalanche Mainnet.
- Utilizar contratos oficiales de Circle CCTP V2.
- Validar constructor, dependencias y direcciones.
- Permitir definir explícitamente deployer, owner y operator según corresponda.
- Nunca asumir que deployer debe quedar como owner definitivo.
- Verificar que las direcciones obtenidas corresponden a la red correcta.
- No reutilizar direcciones Fuji.
- Preparar verificación de bytecode.
- Separar preparación, simulación y ejecución.

Crear comandos de `preflight` y `dry-run` que no transmitan transacciones.

Los comandos capaces de desplegar deben permanecer bloqueados para Mainnet hasta una habilitación explícita futura.

No reutilizar `DEV_EVM_PAYER_PRIVATE_KEY` como mecanismo de firma productiva.

No es necesario implementar una solución HSM/KMS completa en esta fase, pero sí definir su integración y evitar mecanismos inseguros como valores predeterminados.

## 3. SCRIPTS DE DESPLIEGUE STELLAR MAINNET

Actualmente contamos con:

`contracts/soroban/deploy-testnet.sh`

Necesito preparar el despliegue de contratos Soroban en Stellar Public Network.

Considerar:

- Account WASM.
- Verificador Ed25519.
- Verificador WebAuthn.
- Account Factory.
- Vault de USDC.
- Dependencias y artefactos que realmente necesite la Factory.

REQUISITOS:

- Utilizar la passphrase oficial de Stellar Public Network.
- Utilizar USDC SAC Mainnet correcto.
- Separar Testnet y Mainnet.
- Verificar cuentas owner y operator.
- Verificar que los contratos referenciados existen.
- Preparar comprobación del hash WASM.
- Validar límites de desembolso.
- Considerar TTL y costos de Soroban.
- Preparar comprobación de reservas y saldo XLM.

No copiar el script Testnet reemplazando únicamente el nombre de red.

Puedes refactorizarlo para compartir lógica, siempre que conserves su funcionamiento anterior.

Los comandos de preparación y preflight deben ser de solo lectura respecto a blockchain.

No ejecutar deploy, upload, invoke ni operaciones que transmitan transacciones.

## 4. OPENZEPPELIN RELAYER MAINNET

Revisa:

- `deploy/relayer/config/config.json`
- `deploy/relayer/config/networks/avalanche.json`
- `deploy/relayer/config/networks/stellar.json`
- Configuración del plugin x402.

Ya existen definiciones de Avalanche Mainnet y Stellar Mainnet en los archivos de redes.

Aprovecha esas definiciones sin duplicarlas innecesariamente.

Implementa configuraciones independientes para Testnet y Mainnet.

REQUISITOS:

- Relayer Avalanche Mainnet separado.
- Relayer Stellar Mainnet separado.
- IDs independientes.
- Firmantes independientes.
- Configuración x402 para las redes Mainnet.
- Validación de los identificadores CAIP-2 que realmente soporta la versión del plugin.
- Webhooks autenticados.
- Protección de endpoints.
- Políticas restrictivas del Relayer.
- Configuración de límites de gastos y comisiones cuando estén soportados.
- Referencia de build del Relayer fijada a un commit o versión verificable, no a `main` mutable.

No necesitas crear keystores reales.

No ejecutar ni reiniciar el Relayer actualmente funcionando en Testnet.

Si alguna política requiere un cambio en el fork del Relayer, informa el bloqueo y prepara la modificación únicamente si pertenece al alcance de este repositorio.

## 5. DOCKER E INFRAESTRUCTURA MAINNET

Actualmente tenemos:

- `deploy/docker-compose.yml`
- `deploy/Dockerfile`
- `deploy/.env.example`
- `deploy/cloud-run/`

Prepara una estrategia de despliegue Mainnet completamente separada de Testnet.

Quiero que:

1. Los servicios Mainnet no compartan accidentalmente bases de datos con Testnet.
2. No compartan secretos ni identidades de firma.
3. No reutilicen volúmenes Docker.
4. No interfieran con los contenedores actuales.
5. La API y el Relayer tengan comunicación segura.
6. La configuración Mainnet sea explícita.
7. Los nombres de servicios, volúmenes y proyectos no provoquen colisiones.
8. `MAINNET_TRANSACTIONS_ENABLED` permanezca desactivado.
9. El QR mock y las claves de desarrollo sigan prohibidos.

Prepara archivos de ejemplo y configuraciones que podamos revisar.

No levantes contenedores.

IMPORTANTE: el análisis anterior identificó riesgos de SQLite/Litestream para operaciones reales.

No quiero ignorar ese problema ni que migres toda la base a PostgreSQL silenciosamente.

Documenta el bloqueo y propone una implementación separada, con impacto, dependencias, migraciones y pruebas, para aprobarla antes de usar fondos reales.

## 6. PREFLIGHT MAINNET

Quiero un comando que podamos ejecutar ANTES de cualquier despliegue para comprobar:

Avalanche:
- Chain ID.
- Conectividad RPC.
- Existencia de USDC oficial.
- Contratos CCTP.
- Compatibilidad de EntryPoint.
- Precompile P-256.
- Compatibilidad de USDC con las firmas utilizadas.

Stellar:
- Network passphrase.
- Conectividad Soroban RPC.
- Horizon.
- USDC SAC.
- Contratos oficiales CCTP.
- CctpForwarder.
- Estado de cuentas públicas necesarias.

General:
- Configuración completa.
- Separación Testnet/Mainnet.
- Versiones de herramientas.
- Artefactos compilados disponibles.
- Compatibilidad del Relayer.
- Direcciones y dependencias verificables.

Distingue tres estados:

- PASS: condición verificada.
- FAIL: bloqueo.
- PENDING: requiere información, acceso o comprobación adicional.

Si se requiere verificar una condición que todavía no se puede comprobar, no la marques como PASS.

El preflight debe realizar exclusivamente lecturas y simulaciones sin efectos sobre blockchain. No debe crear cuentas, aprobar tokens, subir WASM ni transmitir transacciones.

## 7. PRUEBAS

Ejecuta, cuando sea posible:

- `npm run typecheck`
- `npm test`
- Tests específicos de configuración Mainnet.
- Tests de separación de entornos.
- Validación de Docker Compose sin iniciar servicios.
- Pruebas de los comandos preflight/dry-run usando mocks.

Si las herramientas EVM/Soroban están disponibles, puedes compilar contratos localmente y ejecutar sus pruebas sin transmisión blockchain.

No instales herramientas globales sin necesidad ni modifiques servicios del sistema.

No cambies ni deshabilites tests antiguos para conseguir una suite verde.

## 8. DOCUMENTACIÓN DE DESPLIEGUE

Crea una guía dentro del repositorio, por ejemplo:

`deploy/MAINNET_DEPLOYMENT.md`

Debe explicar:

1. Prerrequisitos.
2. Qué contratos de TilcAI debemos desplegar.
3. Qué contratos oficiales debemos reutilizar.
4. Qué herramientas necesitamos.
5. Cómo configurar el entorno sin exponer secretos.
6. Cómo ejecutar preflight.
7. Cómo compilar contratos.
8. Orden de despliegue Avalanche.
9. Orden de despliegue Stellar.
10. Cómo verificar direcciones, bytecode, WASM, propietarios y operadores.
11. Cómo configurar el Relayer.
12. Cómo preparar Docker Mainnet.
13. Cómo validar API y workers sin mover fondos.
14. Qué debe aprobarse antes de habilitar transacciones.
15. Qué comandos de despliegue existirán y qué efectos producirán.
16. Qué riesgos no pueden revertirse y cómo detener o recuperar operaciones ante incidentes.

Separa claramente comandos de solo lectura de comandos que modificarían blockchain.

No incluyas claves privadas, contraseñas o secretos en documentación.

## 9. RESTRICCIÓN CRÍTICA

Esta fase es únicamente PREPARACIÓN.

No ejecutar ningún comando de despliegue.

No configurar ni fondear wallets reales.

No activar `MAINNET_TRANSACTIONS_ENABLED`.

No publicar imágenes.

No alterar infraestructura en ejecución.

No realizar transacciones de ninguna red.

No presentar el sistema como listo para fondos reales mientras existan contratos sin auditar o bloqueos críticos de seguridad.

## 10. RESPUESTA FINAL

Responde COMPLETAMENTE EN ESPAÑOL con:

1. Resumen de lo implementado.
2. Archivos creados y modificados.
3. Scripts preparados para Avalanche.
4. Scripts preparados para Stellar.
5. Configuración Mainnet del Relayer.
6. Configuración Docker.
7. Variables de entorno pendientes.
8. Resultados de pruebas.
9. Resultado de validaciones de solo lectura, si se ejecutaron.
10. Bloqueos de seguridad pendientes.
11. Contratos que necesitarán desplegarse realmente, ordenados por red.
12. Qué acciones requieren AVAX o XLM y cuáles no.
13. Próximos pasos para realizar un despliegue controlado cuando esté aprobado.

Respeta las instrucciones de `AGENTS.md` y registra el historial sin secretos.

**No hagas commit ni push. Detente al terminar y espera mi aprobación antes de cualquier operación on-chain.**