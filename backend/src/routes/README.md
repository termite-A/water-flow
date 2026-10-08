# API Route Map

Routes are mounted from `src/app.ts`. The following files own the handlers and their URL paths:

| Method | URL                             | File                   | Purpose                                    |
| ------ | ------------------------------- | ---------------------- | ------------------------------------------ |
| GET    | `/api/health`                   | `auth.routes.ts`       | Database and MQTT health                   |
| POST   | `/api/auth/login`               | `auth.routes.ts`       | Administrator sign-in                      |
| GET    | `/api/auth/session`             | `auth.routes.ts`       | Validate administrator session             |
| POST   | `/api/auth/logout`              | `auth.routes.ts`       | Revoke administrator session               |
| GET    | `/api/dashboard`                | `monitoring.routes.ts` | Latest measurements and device states      |
| GET    | `/api/devices`                  | `monitoring.routes.ts` | Device registry                            |
| GET    | `/api/history`                  | `monitoring.routes.ts` | Filtered, paginated water readings         |
| GET    | `/api/activities`               | `monitoring.routes.ts` | System and gateway events                  |
| GET    | `/api/settings`                 | `settings.routes.ts`   | Read per-device calibration and thresholds |
| PUT    | `/api/settings/:deviceCode`     | `settings.routes.ts`   | Save calibration and thresholds            |
| PATCH  | `/api/devices/:deviceCode/mode` | `gateway.routes.ts`    | Queue a manual/automatic mode change       |
| POST   | `/api/gateway/commands`         | `gateway.routes.ts`    | Queue an open/close command                |
| GET    | `/api/device/commands`          | `gateway.routes.ts`    | Authenticated Uno/A7670 HTTP command poll  |
| POST   | `/api/telemetry`                | `telemetry.routes.ts`  | Authenticated sensor telemetry ingestion   |
| WS     | `/api/ws`                       | `src/realtime.ts`      | Authenticated live dashboard events        |

Shared services and middleware are initialized in `src/app.ts`; route modules receive those dependencies through `routes/context.ts`.
