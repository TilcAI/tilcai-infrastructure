# Escritor único y restore en Cloud Run (N-07)

Investigación de [N-07 · #33](https://github.com/TilcAI/tilcai-infrastructure/issues/33). El objetivo es
saber si el despliegue de Cloud Run puede tener dos escritores sobre historias SQLite distintas y si
el restore conserva la historia esperada.

**Estado: `NEEDS_VALIDATION`.** El análisis de la configuración y de la documentación de la plataforma
está hecho. El ensayo en staging **no se ejecutó**, porque no hay un entorno autorizado. Ningún
incidente se observó: lo que sigue son hipótesis con su evidencia y la forma de confirmarlas o
descartarlas. El despliegue **no** se declara seguro solo por lo que dice el YAML.

Base auditada: Infrastructure `58066a73`, Core `f642c258`. Litestream `0.3.13` (`deploy/Dockerfile`).

## 1. Cómo está desplegado hoy

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Instancias | `deploy/cloud-run/tilcai.service.yaml` | `autoscaling.knative.dev/minScale: "1"` y `maxScale: "1"` **en la plantilla de la revisión**. No hay límite de instancias a nivel de servicio. |
| CPU | ídem | `run.googleapis.com/cpu-throttling: "false"`: el worker trabaja aunque no haya peticiones. |
| Proceso | `deploy/entrypoint.sh` | `TILCAI_ROLE=all`: API **y** worker de conciliación en el mismo proceso. |
| Disco | Cloud Run gen2 | Efímero: cada instancia nueva arranca sin `/data/tilcai.db`. |
| Restore | `entrypoint.sh` | `litestream restore -if-db-not-exists -if-replica-exists -o $DATABASE_PATH $LITESTREAM_REPLICA_URL` |
| Réplica | `entrypoint.sh` | `litestream replicate -exec "node …"` hacia `gcs://BUCKET/tilcai`, **la misma ruta para todas las revisiones**. |
| Sondas | manifiesto | startup y liveness en `/health`. |
| Fencing | — | No hay: nada impide que dos procesos escriban, ni que dos Litestream repliquen en la misma ruta. |

## 2. Lo que dice la documentación de las plataformas

- **El máximo de instancias es por revisión cuando se fija en la revisión.** Cloud Run asigna 100 por
  revisión por defecto, y el límite de servicio es el que conviene para acotar el total. Además, *"this
  maximum setting can be exceeded for a brief period due to circumstances such as traffic spikes"*.
  ([max instances](https://docs.cloud.google.com/run/docs/configuring/max-instances))
- **Las revisiones con etiqueta se mantienen encendidas.** El mínimo de instancias de una revisión se
  mantiene mientras esté en un reparto de tráfico o tenga etiqueta: *"all tagged revisions are started
  and then kept active, even when there are no incoming requests"*. Una revisión sin tráfico y sin
  etiqueta no se mantiene, pero la documentación no dice cuánto tarda en apagarse.
  ([min instances](https://docs.cloud.google.com/run/docs/configuring/min-instances))
- **Litestream exige un solo replicador por ruta:** *"Multiple applications replicating into the same
  bucket & path can cause situations where you will be unable to restore"* y *"It is your
  responsibility to ensure you do not have multiple applications replicating concurrently."*
  ([tips](https://litestream.io/tips/))
- **Litestream 0.3 trabaja con generaciones.** Se abre una generación nueva en la primera réplica y
  cada vez que la secuencia del WAL deja de ser contigua. `restore` sin `-generation` usa *"generation
  with latest data"*. ([restore v0.3](https://litestream.io/v0.3/reference/restore/),
  [how it works](https://litestream.io/how-it-works/)). La documentación no precisa cómo ordena las
  generaciones: hay que medirlo.

## 3. Hipótesis

| # | Hipótesis | Evidencia | Qué la confirma |
| --- | --- | --- | --- |
| H1 | En un despliegue conviven la instancia vieja y la nueva: el límite de 1 es por revisión y el servicio no tiene límite propio. | Manifiesto y documentación de max instances. `deploy/README.md` ya lo advierte ("conviven dos"). | E1: número de instancias por revisión en Cloud Monitoring durante el rollout. |
| H2 | Durante esa convivencia **los dos escriben**: la vieja sigue con su worker (CPU permanente) hasta recibir SIGTERM, aunque ya no reciba tráfico. La nueva restauró una foto de antes. | `cpu-throttling: false` y `TILCAI_ROLE=all`. La documentación no dice cuánto vive la instancia vieja. | E1: última escritura de la vieja posterior al restore de la nueva. |
| H3 | Las dos replican en la misma ruta. En Litestream 0.3 cada arranque restaurado abre una generación nueva, y el restore siguiente toma una sola: lo que escribió la otra **se pierde**. Si la nueva cae pronto y la vieja escribió último, el restore podría elegir la generación **vieja** y perder lo que entró por la nueva. | Documentación de Litestream (un replicador por ruta; generaciones; "latest data"). | E1 y E4: `litestream generations` en el bucket, más el `verify` del script tras un restore limpio. |
| H4 | Una revisión **etiquetada** (`gcloud run … --tag`) queda encendida para siempre con su worker y su Litestream: un segundo escritor permanente. | Documentación de min instances. | E2: instancias por revisión con una etiqueta puesta. |
| H5 | Si la réplica no existe en la ruta configurada (ruta mal escrita, bucket vaciado), `-if-replica-exists` arranca con una base **vacía** que se ve sana, y empieza a replicar una historia nueva. | `entrypoint.sh`. | E3. |

**Qué está en juego si se confirman.** Esto es inferencia a partir del código, no algo observado.

- **Lo que protege la cadena.** El burn usa la autorización EIP-3009 del pagador, con su nonce, y el
  mint usa el nonce de CCTP: los dos se rechazan si se repiten. Un desembolso del vault con el mismo
  `disbursementId` también se rechaza (`AlreadyDisbursed` en `contracts/evm/src/TilcaiVault.sol`).
  El despliegue de cuentas usa CREATE2, que es determinista.
- **Lo que no protege.** La **idempotencia de la API vive en la SQLite local**
  (`getByIdempotencyKey`). Puede fallar si un reintento con la misma `Idempotency-Key` llega a la otra
  instancia durante la convivencia, o después de un restore que perdió el registro. En ese caso se crea
  un desembolso con **otro** id, que el contrato paga. El daño queda acotado por `maxPerDisbursement`
  y `dailyLimit`.
- **Lo que se pierde de la historia.** Desaparecen pagos, desembolsos, recibos, claves emitidas y
  eventos del monitor que vivían en la generación descartada. TilcAI deja de saber lo que ya hizo en
  la cadena, y conciliarlo pasa a ser manual.

**RPO.** En Litestream 0.3 el intervalo de sincronización por defecto es de 1 s; `deploy/README.md`
ya lo cita. Eso es lo que se pierde en una caída limpia de **un** escritor. Con dos escritores, el RPO
no está acotado por el intervalo: es todo lo que escribió el que pierde (H3).

## 4. Protocolo de staging

**Requisitos (bloqueantes):**
- Proyecto de GCP de staging **autorizado** por operación (José), separado de producción, con su
  propio bucket.
- Sin fondos. El relayer apunta a una URL inexistente (`RELAYER_URL=http://127.0.0.1:9`) o está
  pausado, y `VAULT_*` está vacío.
- `QR_MOCK_ENABLED=true`, con credenciales propias.

Las escrituras sintéticas las hace [`deploy/staging/n07-writer.mjs`](staging/n07-writer.mjs). Crea
QR en el mock (no mueve dinero) con la glosa `N07 <run> #<n>` y anota cada respuesta. `verify` lee los
eventos `qr.created` de la base que quedó y lista lo confirmado que falta. El token del mock vive en la
base: un `relogin` en las anotaciones ya indica que la base cambió debajo del cliente.

```sh
export QR_MOCK_EMAIL=… QR_MOCK_PASSWORD=… TILCAI_API_KEY=<clave de operador de staging>
node deploy/staging/n07-writer.mjs write  --url $URL --run e1 --rate 5 --minutes 10 --out e1.jsonl
node deploy/staging/n07-writer.mjs verify --url $URL --run e1 --acks e1.jsonl
litestream generations gcs://BUCKET/tilcai        # desde una máquina con acceso al bucket
```

| Ensayo | Pasos | Se mide |
| --- | --- | --- |
| E0 · línea base | Revisión A, escritor 10 min, `verify`. | Nada perdido; una generación. |
| E1 · rollout | Escritor en marcha; `gcloud run services replace` con un cambio trivial (revisión B). A los 5 min, otra revisión C para forzar un restore limpio; después `verify` contra C. | Instancias por revisión (Cloud Monitoring `container/instance_count`); hora del restore de B, del cambio de tráfico, del SIGTERM y de la última línea de log del worker de A (Cloud Logging por `revision_name`); generaciones en el bucket; `lost` de `verify`. |
| E2 · etiqueta | `gcloud run services update-traffic tilcai --set-tags=canary=<A>` con B al 100 %. Escritor 10 min, `verify`, quitar la etiqueta. | ¿A sigue con instancia y worker? ¿Hay dos generaciones activas? |
| E3 · réplica ausente | Revisión con `LITESTREAM_REPLICA_URL` en una ruta vacía. Repetir quitando a la cuenta de servicio el permiso sobre el bucket. | ¿Arranca vacía y sana (`/health` 200) o falla? ¿Qué replica después? |
| E4 · caída brusca | Con la misma imagen en una VM o en Docker local con réplica `gcs://` de staging: escritor y `docker kill -s KILL`; arrancar de nuevo, restaurar y `verify`. Cloud Run no permite matar una instancia a mano. | RPO real de un escritor: confirmadas antes del kill que faltan. |
| E5 · rollback | `gcloud run services update-traffic tilcai --to-revisions=<A>=100` con el escritor en marcha; `verify` tras un restore limpio. | Lo mismo que en E1, en sentido inverso. |

**Registro de cada ensayo:** el manifiesto exacto (revisiones y digest de imagen), una línea de tiempo
con horas UTC, las salidas de `verify` y de `litestream generations`, y los logs de Cloud Logging
**sin secretos**. Todo se adjunta al issue. Si staging no se autoriza, el issue se cierra como
**pendiente de validación**, no como riesgo resuelto.

**Ensayo local del protocolo (2026-11-01, sin Cloud Run).** Este ensayo comprueba el script, no la
plataforma. Se levantó la API con el mock (A) y el escritor a 10 QR/s durante 6 s. A los 3 s se tomó
una copia consistente de la base con `VACUUM INTO`, como un restore. Después se levantó B sobre la
copia. Resultado: `verify` contra A dio 29 confirmadas, 29 guardadas y 0 perdidas; contra B, 29
confirmadas, 14 guardadas y **15 perdidas (15–29)**, que son las que A escribió después de la copia.
Es exactamente el patrón que E1 tiene que buscar en Cloud Run.

## 5. Mitigaciones para decidir (D-06)

No se aplica ninguna sin la medición y la aprobación de operación. Cambiar el despliegue es una
decisión posterior.

1. **Reglas de operación inmediatas, sin cambiar código:**
   - no etiquetar revisiones de `tilcai` (H4);
   - publicar solo sin pagos ni desembolsos en curso, como ya dice `deploy/README.md`;
   - después de cada rollout, comprobar que la revisión vieja ya no tiene instancias.
2. **Límite de instancias a nivel de servicio en 1.** Hay que medirlo en staging: si la revisión nueva
   no puede arrancar mientras la vieja tiene la única instancia, el rollout fallaría con *"No available
   container instances"*.
3. **Fencing en la aplicación.** Un lease en el bucket con precondición de generación de GCS: la
   instancia toma el lease **antes** del restore, lo renueva, y deja de escribir y de correr el worker
   si lo pierde. Así la nueva espera a que la vieja suelte. Es un cambio de código mediano y necesita
   su propio issue.
4. **No arrancar con la base vacía si hay réplica configurada (H5),** salvo con un
   `LITESTREAM_ALLOW_EMPTY=true` explícito para el primer despliegue. Es un cambio pequeño en
   `entrypoint.sh` que conviene hacer aunque las demás hipótesis no se confirmen.
5. **De fondo:** una VM con disco persistente y `docker-compose.yml`, que es la recomendación actual
   de `deploy/README.md`, o un almacén transaccional compartido (Postgres o Cloud SQL), ya señalado
   como decisión separada en `deploy/MAINNET_DEPLOYMENT.md`. Antes de elegir, comparar costo y RPO.

## 6. Checklist del issue

- [ ] Ensayo con IDs sintéticos antes, durante y después del rollout: **protocolo y herramienta listos;
  falta staging autorizado.**
- [ ] Número de escritores, cursor de la réplica, filas y recibos al recuperar, arranque sin réplica y
  error de restore: E1–E5, pendientes.
- [x] Sin staging autorizado no se declara Cloud Run seguro; queda como **pendiente de validación**.
- [ ] Decisión de topología y RPO, y un issue de mitigación aparte: después de medir.
- [ ] Revisión independiente de @JHAMILCALI (SQLite) y @joseemen11 (operación).
