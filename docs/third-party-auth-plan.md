# Decisión de autenticación para terceros

Fecha: 2026-11-01. Optipagos/Fexpo son ejemplos de integraciones, no tenants creados por esta tarea.

| Opción | Uso adecuado | Coste y decisión |
| --- | --- | --- |
| API keys por tenant/entorno/scopes | Backend de un socio actuando por su propia integración | Elegida para API REST actual: ya existe registro, revocación y cuotas; ampliar ciclo de vida |
| OAuth client credentials | Backend confidencial con access tokens breves e identidad federada | Evolución si hay IdP, exigencia de tokens cortos o múltiples audiencias; no sustituye por sí solo la credencial de cliente |
| OAuth authorization code + PKCE | Usuario delegando acceso, navegador o MCP remoto multiusuario | Necesario al ofrecer esa delegación; flujo distinto de la integración servidor a servidor |

RFC6749 limita client credentials a clientes confidenciales y describe recursos propios o acceso
preacordado ([fuente](https://www.rfc-editor.org/rfc/rfc6749.html)). RFC9700 aporta prácticas
actuales de seguridad OAuth ([fuente](https://www.rfc-editor.org/info/rfc9700/)). El MCP HTTP
remoto tiene su propia autorización; no reenviar tokens de otros recursos ni presentar una API
key como implementación OAuth ([especificación MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx)).

## Plan implementable

1. Conservar onboarding por CLI de operador y secretos mostrados una sola vez. Un tenant por
   organización y claves independientes por servicio: fexpo/backend, optipagos/backend, staging.
2. Nuevas claves con 256 bits, hash SHA256, scopes explícitos, expiración por defecto 90 días,
   máximo 365, prefijos test/live y validación de entorno en servidor. Claves env heredadas se
   conservan como puente operativo, no para onboarding de socios.
3. Rotación CLI atómica: heredar tenant/scopes/entorno, nueva key, vieja revocada de inmediato
   o solapamiento explícito hasta 24h sin extender expiración anterior. Auditoría sin secretos.
4. Añadir introspección de la propia credencial para SDK/MCP: tenant, scopes, entorno y fechas;
   ninguna ruta pública emite claves ni enumera otros tenants. SDK permite proveedor dinámico
   de credenciales para rotación desde secret manager. MCP stdio local usa el mismo cliente y
   no revela secretos en herramientas ni stdout; MCP remoto OAuth permanece fase independiente.
5. Tests de vencimiento, ambiente, scopes, suspensión/revocación, rotación/rollback, aislamiento,
   endpoint propio y SDK/MCP. Migración aditiva y despliegue backend antes del SDK que la usa.

La gestión continúa siendo de operador con acceso local al DB; no se crea panel público ni
se entrega a un socio capacidad de emitir scopes nuevos. No usar claves en frontend, apps
móviles, query strings ni repositorios. HTTPS en despliegue; entrega por gestor de secretos.
Auditoría de ciclo de vida y lastUsedAt no reemplazan rate limiting de gateway. Las cuotas
existentes controlan patrocinio; los límites de tráfico deben configurarse en el ingreso.

La rama feat/third-party-credentials parte de 73805cc y contiene todos los fixes previos.
