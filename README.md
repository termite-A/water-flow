<<<<<<< HEAD
# Water Flow Controller

Administrator-only water-level monitoring and irrigation gateway management. The frontend is React, TypeScript, Vite, and Tailwind CSS. The backend is Express/TypeScript with PostgreSQL, MQTT, authenticated WebSockets, and device telemetry validation.

The application does not generate sensor values. Without a reachable PostgreSQL database and a valid administrator session, it remains on the sign-in screen and reports the database error. A device with no recent measurement is shown as offline/stale, never as a current reading.

## Existing Database

The canonical starting point is [`backend/sql/water_conn.session.sql`](backend/sql/water_conn.session.sql). The prompt mentioned `water_conn.seesion.sql`; the supplied file was spelled `water_conn.session.sql` and has been moved here unchanged. It keeps the existing canals, devices, readings, schedules, gate commands, and alerts tables, then adds administrator/session storage, calibration and configurable thresholds, gateway activity, events, and idempotency support. The duplicate `backend/sql/schema.sql` has been removed.

Back up the existing database before applying the additive SQL. After `DATABASE_URL` is set in `backend/.env`, run the migration from the backend folder:

```powershell
cd backend
npm run db:apply
```

The migration runner uses the existing connection from `.env` and prints device codes only. The schema does not insert sample users, devices, thresholds, or sensor values. Register the actual canal/device record in PostgreSQL; the Uno sketch's default ID is `waterflow-001`, so its `DEVICE_ID` must match a real `devices.device_code` associated with the correct existing canal. Set verified calibration endpoints and operating thresholds in the administrator Settings view.

## Configure and Run

1. Copy `backend/.env.example` to `backend/.env` and set the existing database connection, a strong `DEVICE_API_KEY`, initial admin username/email/password, and the actual MQTT broker URL/credentials if MQTT is also used. The bootstrap password must be at least 12 characters. Keep `.env` private.
2. Apply `backend/sql/water_conn.session.sql` to the existing PostgreSQL database.
3. Start the API in one PowerShell terminal:

```powershell
cd backend
npm run dev
```

4. Start the website in a second terminal:

```powershell
cd frontend
npm run dev
```

5. Open `http://localhost:5173` and sign in with the configured administrator account. There is no public registration route. The API is at `http://localhost:4000`.

The first administrator is created from environment variables only if its username/email is not already present. No credentials are included in this repository.

## Deploy on Vercel

Set the Vercel project Root Directory to the repository root, not `frontend`; the root `vercel.json` builds the frontend and routes `/api/*` requests to the serverless API. Add `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` to the Vercel project's environment variables, then apply the existing database schema before signing in. The first database-backed API request creates the initial administrator when those admin variables are configured. Keep secrets out of the repository. When the frontend and API are served from the same Vercel domain, no `FRONTEND_ORIGIN` override is needed.

## Device Protocol

The device may POST a reading to `/api/telemetry` with `Authorization: Bearer <DEVICE_API_KEY>`, or publish JSON over MQTT. The Arduino Uno/A7670 sketch uses HTTP(S): it posts telemetry and polls `GET /api/device/commands?deviceId=<device-code>` with the same bearer key. The poll returns a queued gate or mode command; telemetry then echoes `commandId` and the device-reported result. The gateway is confirmed only from that report.

- `waterflow/device/{deviceCode}/water-level`
- `waterflow/device/{deviceCode}/status`
- `waterflow/device/{deviceCode}/gateway`
- `waterflow/device/{deviceCode}/events`
- `waterflow/device/{deviceCode}/command` (backend to device)

Telemetry accepts `deviceId`, optional unique `messageId` and `commandId`, `sensorValue` or `rawSensorValue`, a calibrated `waterLevel`/`waterLevelPct`, optional `waterLevelM`, gateway status, servo angle, control mode, and measurement time. The Uno sketch sends the raw A0 reading; configure `raw_at_low_level` and `raw_at_high_level` from real calibration observations before expecting a percentage. No raw-to-level conversion is guessed. The backend classifies calibrated values using saved per-device LOW/NORMAL/HIGH thresholds and broadcasts committed results to authenticated WebSocket clients.

Gateway commands are queued in PostgreSQL if MQTT is offline. The HTTP polling endpoint allows the Uno to receive those commands over the A7670 data connection. Commands are not marked confirmed when sent or polled; the UI waits for a matching device report of `OPEN` or `CLOSED`. `MOVING`, `ERROR`, timeout, or a lost connection do not count as success. Automatic thresholds should only be configured after local safety approval and fail-safe review.

## Arduino Uno and A7670

Firmware is in [`firmware/arduino_uno_a7670/arduino_uno_a7670.ino`](firmware/arduino_uno_a7670/arduino_uno_a7670.ino). It uses Arduino's `SoftwareSerial` and `Servo` libraries and the A7670's native HTTP(S) AT commands; TinyGSM's current supported-modem list includes A7672X, not A7670.

| Signal                    | Arduino Uno pin                     |
| ------------------------- | ----------------------------------- |
| Analog water-level sensor | A0                                  |
| Red LED                   | D3 (with series resistor)           |
| Green LED                 | D6 (with series resistor)           |
| Piezo buzzer              | D11                                 |
| Servo signal              | D12                                 |
| A7670 TX to Uno RX        | D8                                  |
| Uno TX to A7670 RX        | D9 through a suitable level shifter |

Before uploading in Arduino IDE (board: Arduino Uno), set `API_BASE_URL` to a publicly reachable HTTPS backend hostname, set the carrier `SIM_APN`, match `DEVICE_ID` to the registered database row, and paste the device API key into the sketch locally. Do not commit that key. The Uno cannot reach `localhost`; a public deployment/tunnel with a trusted TLS certificate is required for cellular access. Configure the A7670 UART to 9600 baud for this sketch and provision TLS trust according to the exact A7670 board/firmware HTTP(S) guide. The modem needs its own stable supply sized for transmit-current bursts; do not power it or a stalled servo from the Uno 5 V pin. Use a level-shifted A7670 development board or proper UART level conversion because bare modem UART pins are not 5 V tolerant.

The sketch preserves the provided raw hysteresis thresholds (`WATER_ON = 300`, `WATER_OFF = 200`) for local LED indication. It reports the raw A0 value; percentage and LOW/NORMAL/HIGH status remain unconfigured until the actual sensor is calibrated in the admin Settings view. Commands are polled every five seconds and telemetry is sent every 15 seconds. This environment has no Arduino CLI/AVR compiler, so the sketch has not been compiled or tested on a physical Uno/A7670. Test the exact sensor polarity, servo mechanics, module baud, carrier APN, and TLS setup on a bench rig first. Do not connect this prototype directly to an operational canal gate without engineering review, independent gate-position feedback, power protection, and an approved manual fallback. Water level is distinct from volumetric flow rate.

## Validation

```powershell
cd frontend
npm run lint
npm run build

cd ..\backend
npm run build
```
=======
# water-flow
>>>>>>> 987e0459867a47bcbe5e84dee8f7e7995ac9857d
