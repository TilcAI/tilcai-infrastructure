# Implementación de la rama: feat/third-party-credentials

> **Documento exclusivo de esta rama. No integrar este archivo en `main`.** Antes de completar un merge o squash, eliminarlo del resultado o excluir este archivo al seleccionar los cambios; revisar el diff final contra `main`. Eliminar el archivo en la rama de destino no elimina su existencia histórica en commits de un merge.

## Qué se implementó y cómo

La rama incorpora las correcciones de Vault/Soroban de #28, #35 y #42 y añade credenciales para socios. La CLI del operador crea tenants y emite, rota y revoca claves limitadas por entorno y scopes, con vencimiento. La migración SQLite 7 agrega los datos necesarios; la autenticación verifica estado del tenant, revocación y vencimiento. Los eventos de auditoría no incluyen secretos.

`GET /v1/auth/context` devuelve tenant, permisos, entorno y metadatos de la propia credencial. SDK y MCP consumen este contrato. Las claves heredadas mantienen su política hasta rotación; emitir una clave nueva no transfiere datos históricos de `tenant_legacy`.

## Validación y pendientes

Evidencia previa: 206 tests unitarios backend y typecheck, además de 5 tests Python y 12 Rust para los fixes incorporados. Verificar orden de migraciones: QR usa 6 y credenciales 7. El despliegue requiere backup y ensayo sobre copia; falta configurar límites de tráfico y onboarding real. OAuth para MCP remoto es fase separada. Las issues siguen abiertas y #32 requiere archivo/restauración real.
