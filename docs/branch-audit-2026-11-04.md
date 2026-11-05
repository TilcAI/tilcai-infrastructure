# Auditoría y limpieza de ramas · 2026-11-04

Base: main con PR48 integrada por squash en 1de7888. Autoría de cambios y PRs revisada antes de seleccionar ramas. Las PRs abiertas de OmarQV no se integran como trabajo de SaulChoque.

## Ramas remotas retiradas por estar incluidas en main

Comprobación: git merge-base --is-ancestor de cada referencia contra origin/main antes de eliminarla.

- feat/mainnet-support
- feat/n-14-sponsored-quota
- feat/qr-providers-fallback
- feat/sca-m1-datos
- fix/n-01-atomic-settlement
- fix/n-10-terminal-reschedule
- fix/relayer-monad-server
- merge/shared-core-to-main

fix/saulchoque-vault-soroban-2026-11-01 fue eliminada después del squash de PR48. feat/continuous-deploy-baneco contiene una eliminación histórica de Core vendorizado: main ya elimina esa copia y usa GitHub Packages/BuildKit. Su configuración anterior de checkout fue sustituida, por lo que no se debe reintroducirla para conservar un commit redundante.

## Rama propia pendiente

feat/third-party-credentials aporta emisión con entorno/caducidad, rotación atómica e introspección. Se combina con main conservando las correcciones Vault actuales. La migración se reasigna de 7 a 8 porque main ya usa 7 para sponsored_holds; no se reescriben migraciones desplegadas. El documento exclusivo de rama se excluye del árbol final. Validación local: 253 tests TypeScript, lint/typecheck, 5 Python y 5 de evidencia offline; CI valida también imagen y arranque.

## Issues y PRs

PR48 está integrada. #28, #35 y #42 tienen implementación y evidencia, pero su DoD exige revisión independiente aún no registrada; no se cierran como aceptadas. #32 conserva pendiente D-05 y revisión de investigación. No se afirma que el experimento local pruebe una garantía infinita. Las PRs #43–#47 y las ramas de otros autores con cambios pendientes se conservan; qa/fase1-reproduccion también tiene commits no incluidos.

Los worktrees con cambios locales se conservan. No se reescribe historia ni se modifica el alcance de web.
