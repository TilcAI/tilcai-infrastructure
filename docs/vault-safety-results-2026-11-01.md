# Implementación y validación: #28, #35 y #42

Base: origin/main 58066a7. Rama: fix/saulchoque-vault-soroban-2026-11-01.
Worktree aislado: ../tilcai-infrastructure-issues. Se preservó el trabajo QR sin publicarlo.

## Cambios

- #28: mapping positivo sin evidencia de receptor/importe conserva estado incierto y reserva.
  RPC caído se reprograma; evidencia persistente Soroban puede confirmar sin hash. La búsqueda
  EVM sigue acotada: no se inventa confirmación si el evento queda fuera de rango. Para recuperar,
  verificar el evento/receipt con proveedor archivado y coordinar recuperación de evidencia con
  operador; nunca reenviar un payout solo por falta de logs. No se añade endpoint manual de confirmación.
- #35: callback síncrono de admisión dentro del BEGIN IMMEDIATE de insert recalcula pendientes
  por red/vault usando BigInt. Idempotencia conserva su constraint y ruta de replay; inserción
  y evento revierten juntos. No requiere migración. Snapshot externo mayor de 30 segundos o
  que cruza día UTC se rechaza; el cliente vuelve a solicitar capacidad actualizada.
- #42: parser Python sin interpolación de código, decimal exacto, rango i128, enum --only,
  direcciones con checksum y manifiesto durable por operación. Una ejecución existente se
  detiene para reconciliación; recuperación detallada en ../contracts/soroban/DEPLOY_RECOVERY.md.

## Evidencia

Reproducción #35 sobre código original: prueba de dos conexiones SQLite con barrera de lectura
falla con `2 !== 1`: admite dos reservas con capacidad para una. Restaurado el código corregido,
la misma prueba acepta solo una. La variante misma clave devuelve el mismo desembolso y un envío.
No se demuestra un sobrepago en cadena.

Validación ejecutada: 201 tests unitarios TypeScript pasan (`npm test`), typecheck pasa,
5 tests Python del deploy pasan, y 12 tests Rust Vault pasan. Los tests añadidos cubren dos
conexiones, reinicio de reserva, rollback de evento/insert, receptor/importe discordantes,
RPC inaccesible, evidencia sin hash, recuperación tardía, snapshot vencido/cambio UTC,
entradas hostiles, precisión, corte parcial y repetición de manifiesto. Se ejecutan offline.

Limitaciones: el snapshot externo no es una transacción con la blockchain. Cambios externos de
saldo/cupo pueden invalidarlo; los contratos mantienen su autoridad y sus límites. Se retienen
conservadoramente todos los pendientes de días anteriores, incluyendo inciertos. Si un payout
ya pagado no está reconciliado, puede descontarse conservadoramente dos veces. La nueva
admisión evita sobrepromesa por reservas locales concurrentes contra el snapshot observado,
no garantiza liquidez futura. Umbral 30s y política UTC requieren revisión operativa.

No se ejecutaron suites de integración contra redes ni despliegues. #32 tiene documento de
investigación separado y no se da por resuelta. Cerrar #28/#35/#42 requiere revisión y los
criterios de sus issues; los cambios aquí no constituyen aprobación de merge/despliegue.
