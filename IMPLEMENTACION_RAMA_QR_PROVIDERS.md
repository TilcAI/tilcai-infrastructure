# Implementación de la rama: feat/qr-providers-fallback

> **Documento exclusivo de esta rama. No integrar este archivo en `main`.** Antes de completar un merge o squash, eliminarlo del resultado o excluir este archivo al seleccionar los cambios; revisar el diff final contra `main`. Eliminar el archivo en la rama de destino no elimina su existencia histórica en commits de un merge.

## Qué se implementó y cómo

La rama contiene el gateway QR con selección de proveedores y fallback, configuración bancaria y monitorización. En QR Simple, el servicio genera la matriz y PNG desde el payload configurado cuando no está vacío o desde el payload propio del código. La misma función se usa en los entornos de desarrollo y producción. El archivo `bank-qr.png` está versionado pero el servicio no lo utiliza como imagen fija.

La configuración `BANECO_BASE_URL` usa el endpoint de producción por defecto. Compose mainnet añade un bind configurable por `MAINNET_TAILSCALE_IP`. Seleccionar explícitamente URL y credenciales de certificación para ese entorno.

## Validación y pendientes

Las 15 pruebas de QR Simple pasaron en la ejecución previa; comprueban generación por payload y coherencia entre imagen y URL. El simulador no acredita abono ni conciliación bancaria. La rama de credenciales es independiente: coordinar migraciones 6 y 7 al integrar.
