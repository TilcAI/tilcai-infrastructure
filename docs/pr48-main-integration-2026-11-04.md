# Integración de PR #48 con main

La rama incorpora main actualizado, incluido el consumo del paquete privado Core 0.1.0 y las correcciones recientes del servicio Vault. El merge se resolvió automáticamente; se conservan tanto las guardas de evidencia/reserva de #48 como las transiciones terminales de main.

Validación local de la combinación: lint y typecheck correctos; 247 tests TypeScript; 5 tests Python del preflight con CLI falsa; 5 tests offline de evidencia TTL. CI ejecuta también Python y la evidencia offline antes de construir/publicar la imagen. No se invocan despliegues Soroban ni pagos públicos para estas validaciones.

Integrar con squash; el archivo IMPLEMENTACION_RAMA_FIX_VAULT_SOROBAN.md sigue excluido del árbol final. #32 continúa pendiente de aceptación D-05; esta integración no cierra automáticamente issues ni reemplaza la revisión humana del horizonte operativo. El merge a main activa el despliegue de aplicación existente, sin upgrade de contratos.
