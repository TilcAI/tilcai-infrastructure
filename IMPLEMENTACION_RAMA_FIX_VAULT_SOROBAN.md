# Implementación de la rama: fix/saulchoque-vault-soroban-2026-11-01

> **Documento exclusivo de esta rama. No integrar este archivo en `main`.** Antes de completar un merge o squash, eliminarlo del resultado o excluir este archivo al seleccionar los cambios; revisar el diff final contra `main`. Eliminar el archivo en la rama de destino no elimina su existencia histórica en commits de un merge.

## Qué se implementó y cómo

- **#28:** la recuperación de payouts exige evidencia concordante de receptor e importe. Si falta evidencia o falla RPC, el servicio mantiene incertidumbre y reserva; la búsqueda EVM es acotada y requiere reconciliación con evidencia histórica.
- **#35:** la admisión recalcula pendientes por vault/red dentro de `BEGIN IMMEDIATE`, usando `BigInt`. Inserción y evento se revierten juntos; snapshots de más de 30 segundos o que cruzan día UTC se rechazan. La prueba con dos conexiones reproduce la carrera original.
- **#42:** el despliegue Soroban valida importes y direcciones con parser Python y aritmética decimal exacta; un manifiesto durable registra cada operación y obliga a reconciliar una ejecución interrumpida.

## Validación y pendientes

Evidencia previa: 201 tests unitarios TypeScript, typecheck, 5 tests Python y 12 Rust. El snapshot no garantiza liquidez futura y las reservas inciertas pueden reducir capacidad conservadoramente. #28/#35/#42 siguen abiertas para revisión. #32 requiere experimento real de archivo/restauración y decisión D-05; no se realizaron despliegues ni integración financiera en red.
