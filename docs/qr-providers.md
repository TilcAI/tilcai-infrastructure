# Cobro con QR: proveedores y fallback

> Estado al 2026-10-15, rama `feat/qr-providers-fallback`. Probado contra los **sandbox** de Banco
> Económico y de Red Enlace ATC: se emiten, consultan y (Baneco) cancelan QR. **No se probó un pago
> real o simulado** de punta a punta: ninguno de los dos sandbox expone, en lo que recibimos, un
> pagador de prueba (ver «Lo que falta»).

TilcAI tiene una pasarela de QR de cobro (`/v1/qr`) que emite un QR bancario con un **proveedor
principal** y, si este falla, continúa con los **proveedores de respaldo** de la lista, en orden.
Es independiente del mock de Vendis (`/mock/vendis`, ver README): el mock sigue sirviendo la API de
Vendis a quien ya integró contra ella, y además es un proveedor más de la pasarela.

## 1. Cómo funciona

```
quien cobra ── POST /v1/qr {amount, description, reference?} ──▶ pasarela
                                                                   │  QR_PROVIDERS = baneco, atc-simple, atc-mld
                                                                   ├─▶ baneco       ✗ (falla)  ─┐ registra el intento
                                                                   ├─▶ atc-simple   ✓ emite     ◀┘
                                                                   └─▶ (atc-mld no se pregunta)
              ◀── 201 {id, provider:"atc-simple", qr_image, attempts:[…]} ─
quien cobra ── GET /v1/qr/:id ──▶ pasarela ──▶ SOLO el proveedor que emitió ese QR
proveedor ── webhook ──▶ /v1/qr/webhooks/… ──▶ la pasarela lo CONFIRMA preguntándole al proveedor
```

Reglas:

1. **Un QR pertenece a un banco.** Emitido por un proveedor, su estado, su cancelación y la
   confirmación del pago van siempre a ese proveedor; el fallback solo existe al emitir.
2. **Orden = rol.** El primero de `QR_PROVIDERS` es el principal; los demás, respaldo. Uno sin
   credenciales se omite (`skipped: not-configured`).
3. **Cualquier fallo al emitir pasa al siguiente:** red, tiempo agotado (`QR_PROVIDER_TIMEOUT_MS`),
   HTTP 4xx/5xx, credenciales rechazadas, rechazo de negocio (`responseCode ≠ 0`, `success:false`)
   o respuesta sin QR. Cada intento queda en `attempts` (proveedor, `ok`, `kind`, `error`, `ms`).
4. **Cortacircuito.** Un proveedor con `QR_PROVIDER_BREAKER_THRESHOLD` (3) fallos seguidos se enfría
   `QR_PROVIDER_COOLDOWN_SECONDS` (60 s): pasa al final de la lista, no se descarta. Si todos están
   fríos, se preguntan igual — una caída no se vuelve apagón. Un éxito limpia la cuenta.
5. **Sin proveedor que pueda.** `502 ALL_PROVIDERS_FAILED` con todos los `attempts`, y el evento
   `qr.provider_failed` (error) en el tablero.
6. **Idempotencia.** Con `reference` (tu número de pedido), pedir dos veces devuelve el mismo QR.
7. **Una caída del proveedor al consultar no cambia el estado guardado**; se anota y se reintenta.
8. **El webhook es solo una pista.** Nunca se marca pagado por lo que dice el cuerpo: se pregunta al
   proveedor (`statusQR` / `verify`). Un QR que el banco aún da por pendiente un minuto después de su
   vencimiento pasa a `EXPIRED`.

### El mock reemplaza o da paso a la API real

| `QR_MOCK_ENABLED` | Proveedores de la pasarela | `/mock/vendis` |
| --- | --- | --- |
| `true` | solo el mock (`provider: "mock"`): no se llama a ningún banco ni se mueve dinero | sirve la API de Vendis; el pago se simula (`POST /v1/qr/:id/simulate-payment` o el botón «Simular depósito») |
| `false` (por omisión) | los de `QR_PROVIDERS`, con fallback | no se registra |

Con el mock activo, `QR_PROVIDERS` y las credenciales reales se ignoran: **ni siquiera se
consultan**. Está prohibido en mainnet. `GET /health` informa `qr: {mode, providers}`.

## 2. Los proveedores

### 2.1 Banco Económico (`baneco`) — API Market v1.3.0

| | |
| --- | --- |
| Certificación | `https://apimktdesa.baneco.com.bo/ApiGateway/` (`BANECO_BASE_URL`) |
| Autenticación | `POST api/authentication/authenticate` `{userName, password}` → JWT (`token`); luego `Authorization: Bearer <token>`. El token dura ~30 min: se cachea y se renueva al expirar o ante un 401 |
| Cifrado | **AES-256-CBC**, relleno PKCS#7, resultado = base64(IV de 16 bytes ‖ cifrado), IV aleatorio por mensaje. La `password` y `accountCredit` van cifradas. Verificado con el vector de la especificación (clave `40A3…8629`, texto `1234`) |
| Emitir | `POST api/qrsimple/generateQR` |
| Estado | `GET api/qrsimple/v2/statusQR/{qrId}` → `statusQrCode`: `0` pendiente, `1` pagado (con `payment[]`), `9` anulado |
| Cancelar | `DELETE api/qrsimple/cancelQR` `{qrId}` (solo QR no pagado de un solo uso, o de varios usos) |
| Notificación | opcional, `POST …/notifyPaymentQR` `{payment:{…}}` publicado por el comercio → `POST /v1/qr/webhooks/baneco?key=<secreto>` |
| Errores de negocio | HTTP 200 con `responseCode ≠ 0` y `message` |

**Restricciones de los campos de `generateQR`** (tabla de la especificación; la pasarela las
verifica antes de llamar, con un mensaje que dice cuál):

| Campo | Tipo | Req. | Límite |
| --- | --- | --- | --- |
| `transactionId` | texto | sí | **30** (la pasarela envía un número de 10 dígitos) |
| `accountCredit` | texto, **cifrado** | sí | **10** caracteres del número de cuenta en claro (`BANECO_PAYMENT_ACCOUNT`) |
| `currency` | texto | sí | 3: `BOB` (la pasarela solo emite en bolivianos) |
| `amount` | decimal | sí | punto decimal, máx. 2 decimales |
| `description` | texto | no | **100** (la glosa se **recorta**, no se rechaza) |
| `dueDate` | fecha `yyyy-MM-dd` | sí | solo fecha: el QR vive hasta el final de ese día en Bolivia (UTC−4); la pasarela informa ese instante como `expires_at` |
| `singleUse` | lógico | sí | `true` un pago, `false` varios |
| `modifyAmount` | lógico | sí | `false` rechaza pagos con otro importe |
| `branchCode` | texto | no | 5 (`BANECO_BRANCH_CODE`) |

Formatos: importes con punto y 2 decimales, fechas `yyyy-MM-dd`, horas `HH:mm:ss`, propiedades en
camelCase. La imagen del QR llega en base64: PNG de 850×850.

### 2.2 Red Enlace ATC — QR Simple (`atc-simple`) y QR MLD / BCB (`atc-mld`)

| | |
| --- | --- |
| Sandbox | `https://atcgwapitest.redenlace.com.bo/sandbox/` (`ATC_BASE_URL`); producción `https://api.redenlace.com.bo/`; QR MLD tiene además `…/desarrollo/` |
| Autenticación | OAuth 2.0 *client credentials*: `POST oauth-client-credentials/access-token?grant_type=client_credentials` con `Authorization: Basic base64(client_id:client_secret)` y `application/x-www-form-urlencoded` → `{access_token, token_type, expires_in: 3600}` (HTTP 201). El token se cachea y **lo comparten QR Simple y QR MLD** |
| Cabeceras de los servicios | `access_token: <token>`, `client_id: <client_id>`, `Content-Type: application/json`. La página de QR MLD también habla de `Authorization: Bearer`; la pasarela envía ambas |
| Emitir | `POST qr/simple/v2/generate` · `POST qr/mld/v2/generate` |
| Estado | `GET qr/simple/v2/verify/{numeroReferencia}` · `GET qr/mld/v2/verify/{…}` — la referencia es la **de ATC** (`data.numeroReferencia`), no la del integrador |
| Cancelar | **no documentado**: la pasarela responde `409 UNSUPPORTED`; el QR caduca solo |
| Webhook | ATC hace `POST` a `webhook.url` con la cabecera `webhook.key: webhook.value` que se le dio al emitir; debe responderse HTTP 200 |
| Estados | `PENDIENTE`, `PAGADO`, `CANCELADO`, `EXPIRADO`, `ERROR` |

Cuerpo de `generate`: `glosa`, `moneda` (`BOB`), `monto` (≤ 2 decimales), `numeroReferencia`,
`vigencia` (segundos), `idEstablecimiento`, `nombreEstablecimiento`, `webhook{url,key,value}`
(**obligatorio**: sin él, `400 REQUIRED_FIELD`).

**Hallazgo del sandbox:** `numeroReferencia` se interpreta como **entero de 32 bits**. Una
referencia de 12 dígitos devolvía `500 «Error al generar QR» — For input string: "1792094140434"`
(`QR_GENERATION_ERROR`). La pasarela envía por eso una referencia numérica entre 100 000 000 y
2 000 000 000. El mismo número va a Baneco como `transactionId`.

Imagen: PNG de 319×319 en base64 (`data.qr`).

### 2.3 `ATC.API.CUENTA.DIGITAL` — qué se sabe

No aparece en la documentación pública del portal (`atc.sensedia-devportal.com`): ni la búsqueda ni
el catálogo de productos la mencionan. Lo más cercano publicado es **«Cuentas de Establecimientos y
Consulta de Saldos»** (`/cuentas-comercios/v1/cuentas`), el API con la que ATC administra las
cuentas de los comercios: consultar estado y listar cuentas por NIT, **alta** de cuentas
(`nit`, `establecimiento{idEstablecimiento, cuenta{alias, rubro, moneda}}`), cambio de estado,
y **consulta de transacciones, créditos, débitos y saldos** (rangos de hasta 31 días, hasta 10
cuentas por consulta de saldos; moneda `068`), con el mismo OAuth que el cobro por QR.

Es una **inferencia, no una confirmación**: por el nombre y por el resto del catálogo, la API
habilitada para este integrador sería la de la **cuenta donde ATC acredita lo cobrado** (el
saldo y los movimientos del comercio), útil para **conciliar** los QR pagados y consultar el
saldo. Para saber qué endpoints expone de verdad hay que pedirle a ATC su especificación. No se
implementó nada contra ella.

## 3. API de la pasarela

Autenticación: claves de `TILCAI_API_KEYS` (`Authorization: Bearer`), alcance `payments`. Los
webhooks se autentican con su propio secreto.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| POST | `/v1/qr` | Emite. `{amount:"12.50", description, reference?, expires_in_seconds? (60–2 592 000, 900), single_use? (true), modify_amount? (false), provider?}`. `201` con `qr_image` (PNG base64) y `attempts`. `provider` fuerza uno y desactiva el fallback (diagnóstico) |
| GET | `/v1/qr/:id` | Estado, refrescado del proveedor que lo emitió. `?image=true` incluye la imagen |
| GET | `/v1/qr` | Últimos QR del tenant |
| POST | `/v1/qr/:id/cancel` | Cancela donde el proveedor lo permite (Baneco) |
| GET | `/v1/qr/providers` | Operador: modo, orden, configuración y estado del cortacircuito |
| POST | `/v1/qr/:id/simulate-payment` | Operador, solo con el mock: paga el QR |
| POST | `/v1/qr/webhooks/atc` | Cabecera `x-tilcai-webhook: <secreto>`; cuerpo con `numeroReferencia` |
| POST | `/v1/qr/webhooks/baneco?key=<secreto>` | `{payment:{qrId,…}}`; responde `{responseCode:0}` |

Estados: `PENDING`, `PAID` (con `payment{amount, paid_at, payer_name, payer_bank, payer_account,
bank_reference}`), `CANCELLED`, `EXPIRED`, `ERROR`. Errores: `INVALID_INPUT` 400, `NOT_FOUND` 404,
`UNSUPPORTED` 409, `ALL_PROVIDERS_FAILED`/`PROVIDER_ERROR` 502, `NO_PROVIDER` 503.

Eventos del tablero: `qr.collection_created` (advertencia si emitió un respaldo),
`qr.collection_paid`, `qr.collection_closed`, `qr.provider_failed`. tilcai-web los cataloga en su
rama `feat/qr-gateway-events`.

El worker consulta cada QR pendiente cada ~10 s (`processDue`), de modo que el pago se ve aunque el
webhook no llegue.

### Configuración

Ver la sección 8 de `.env.example`. Mínimo: `BANECO_USER/PASSWORD/ENCRIPTION_KEY/PAYMENT_ACCOUNT`
y `ATC_CLIENT_ID/SECRET`; `QR_PUBLIC_URL` (o `ATC_WEBHOOK_URL`) para que ATC pueda avisar.
`ATC_ESTABLISHMENT_ID/NAME` son los del establecimiento habilitado (en sandbox, `1` y `TilcAI`
fueron aceptados).

## 4. Pruebas

### CLI

```sh
# Base propia para no tocar la de la instancia; el mock apagado para llamar a los bancos.
export QR_MOCK_ENABLED=false DATABASE_PATH=/tmp/qr.db
npm run qr -- providers                       # orden, rol y configuración
npm run qr -- probe --amount 0.10 --out /tmp/qr   # un QR por proveedor, cada uno forzado
npm run qr -- generate --amount 0.10          # principal primero, luego los respaldos
npm run qr -- status <id>
npm run qr -- cancel <id>
```

### Resultado contra los sandbox (2026-10-15, Bs 0.10)

| Prueba | Resultado |
| --- | --- |
| `baneco` forzado | emitido en ~1.3 s; PNG 850×850; vence a las 23:59:59 (Bolivia) del día |
| `atc-simple` forzado | emitido en ~1.6 s; PNG 319×319; vigencia 900 s |
| `atc-mld` forzado | emitido en ~2.4 s; PNG 319×319; vigencia 900 s |
| estado de los tres | `PENDING` |
| cancelar `baneco` | `CANCELLED` (el banco aceptó el `DELETE`) |
| cancelar `atc-simple` | `UNSUPPORTED`, como se esperaba |
| fallback, Baneco inalcanzable (`BANECO_BASE_URL` a un puerto cerrado) | `baneco: network (19 ms)` → emitió `atc-simple` |
| fallback, Baneco con credenciales malas | `baneco: auth «Credenciales de autenticacion no validas»` → emitió `atc-simple` |
| primer intento de ATC | `500 QR_GENERATION_ERROR` por la referencia de 12 dígitos (corregido, ver 2.2) |

### Pruebas automáticas

`npm test -- test/unit/qrcollect.test.ts` (17 casos, `fetch` simulado, sin red): vector AES del
banco, cuerpo y cabeceras de cada API, renovación de token, límites de campos, mapeo de estados,
cadena de fallback de tres proveedores, omitidos, cortacircuito, idempotencia, interrupción del
proveedor, caducidad, cancelación, modo mock y webhooks.

## 5. Lo que falta

- **Un pago de punta a punta.** Con los sandbox no hay un pagador: hace falta que cada banco
  habilite un simulador o una cuenta de prueba que pague el QR para validar el webhook, el
  `statusQR`/`verify` de un QR `PAGADO` y los datos del pagador. El mapeo de esos campos sale de la
  documentación, no de una respuesta real.
- **Webhooks**: ATC y Baneco necesitan una URL pública (`QR_PUBLIC_URL`); sin ella solo funciona el
  sondeo. ATC no documenta reintentos ni firma del webhook, por eso la pasarela siempre confirma.
- **Cancelación en ATC**, **`ATC.API.CUENTA.DIGITAL`** y la conciliación diaria
  (`GET api/qrsimple/v2/paidQR/{yyyyMMdd}` de Baneco) quedan sin implementar.
- **Desembolso**: la pasarela detecta el pago y emite `qr.collection_paid`; el desembolso del vault
  por un QR pagado sigue siendo el flujo del mock de Vendis y no está conectado a esta pasarela.
- `ATC_ESTABLISHMENT_ID` / `ATC_ESTABLISHMENT_NAME`: en producción son los del comercio habilitado.
