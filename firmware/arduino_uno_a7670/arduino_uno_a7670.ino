#include <SoftwareSerial.h>
#include <Servo.h>

// A7670 native HTTP(S) AT interface; this is not the TinyGSM A7672X profile.
SoftwareSerial modem(8, 9); // Uno RX, TX; use a level-shifted A7670 development board.
Servo gateServo;

const char DEVICE_ID[] = "waterflow-001";
const char API_BASE_URL[] = "https://YOUR_PUBLIC_API_HOST";
const char DEVICE_API_KEY[] = "PASTE_DEVICE_API_KEY_HERE";
const char SIM_APN[] = "YOUR_SIM_APN";

const uint8_t WATER_SENSOR_PIN = A0;
const uint8_t RED_LED_PIN = 3;
const uint8_t GREEN_LED_PIN = 6;
const uint8_t PIEZO_PIN = 11;
const uint8_t SERVO_PIN = 12;

const int WATER_ON = 300;
const int WATER_OFF = 200;
const uint8_t GATE_CLOSED_ANGLE = 0;
const uint8_t GATE_OPEN_ANGLE = 135;
const unsigned long MODEM_BAUD = 9600;
const unsigned long TELEMETRY_INTERVAL_MS = 15000;
const unsigned long COMMAND_POLL_INTERVAL_MS = 5000;
const size_t MODEM_RESPONSE_CAPACITY = 430;

char modemResponse[MODEM_RESPONSE_CAPACITY];
char currentGatewayStatus[8] = "CLOSED";
char currentControlMode[12] = "MANUAL";
bool waterThresholdLatched = false;
bool modemReady = false;
unsigned long lastTelemetryAt = 0;
unsigned long lastCommandPollAt = 0;

bool readModemUntil(const char *expected, unsigned long timeoutMs, char *output, size_t outputSize)
{
  size_t length = 0;
  const unsigned long startedAt = millis();
  if (outputSize > 0)
    output[0] = '\0';

  while (millis() - startedAt < timeoutMs)
  {
    while (modem.available())
    {
      const char value = static_cast<char>(modem.read());
      if (length + 1 < outputSize)
      {
        output[length++] = value;
        output[length] = '\0';
      }
      if (strstr(output, expected) != NULL)
        return true;
      if (strstr(output, "ERROR") != NULL)
        return false;
    }
  }
  return false;
}

bool sendAt(const char *command, const char *expected, unsigned long timeoutMs)
{
  while (modem.available())
    modem.read();
  modem.println(command);
  return readModemUntil(expected, timeoutMs, modemResponse, sizeof(modemResponse));
}

bool waitForNetwork()
{
  char command[96];
  snprintf(command, sizeof(command), "AT+CGDCONT=1,\"IP\",\"%s\"", SIM_APN);
  if (!sendAt(command, "OK", 5000))
    return false;
  sendAt("AT+CGATT=1", "OK", 30000);
  sendAt("AT+NETOPEN", "OK", 30000);
  return true;
}

bool beginHttp(const char *url)
{
  sendAt("AT+HTTPTERM", "OK", 1000);
  if (!sendAt("AT+HTTPINIT", "OK", 5000))
    return false;
  if (!sendAt("AT+HTTPPARA=\"CID\",1", "OK", 3000))
    return false;

  char command[250];
  snprintf(command, sizeof(command), "AT+HTTPPARA=\"URL\",\"%s\"", url);
  if (!sendAt(command, "OK", 3000))
    return false;
  if (!sendAt("AT+HTTPPARA=\"CONTENT\",\"application/json\"", "OK", 3000))
    return false;
  snprintf(command, sizeof(command), "AT+HTTPPARA=\"USERDATA\",\"Authorization: Bearer %s\"", DEVICE_API_KEY);
  return sendAt(command, "OK", 3000);
}

bool readHttpAction(uint8_t method, int &statusCode, int &contentLength)
{
  char command[24];
  snprintf(command, sizeof(command), "AT+HTTPACTION=%u", method);
  if (!sendAt(command, "OK", 5000))
    return false;

  if (!readModemUntil("+HTTPACTION:", 45000, modemResponse, sizeof(modemResponse)))
    return false;
  const char *actionLine = strstr(modemResponse, "+HTTPACTION:");
  if (actionLine == NULL)
    return false;
  unsigned int responseMethod = 0;
  if (sscanf(actionLine, "+HTTPACTION: %u,%d,%d", &responseMethod, &statusCode, &contentLength) != 3)
    return false;
  return responseMethod == method;
}

bool readHttpBody(char *output, size_t outputSize, int contentLength)
{
  if (outputSize == 0 || contentLength <= 0)
    return false;
  char command[32];
  snprintf(command, sizeof(command), "AT+HTTPREAD=0,%d", contentLength);
  while (modem.available())
    modem.read();
  modem.println(command);
  if (!readModemUntil("OK", 8000, output, outputSize))
    return false;
  return strstr(output, "+HTTPREAD:") != NULL;
}

bool httpGet(const char *url, char *body, size_t bodySize, int &statusCode)
{
  int contentLength = 0;
  if (!beginHttp(url))
  {
    sendAt("AT+HTTPTERM", "OK", 1000);
    return false;
  }
  const bool actionOk = readHttpAction(0, statusCode, contentLength);
  bool bodyOk = true;
  if (actionOk && statusCode == 200 && contentLength > 0)
  {
    bodyOk = readHttpBody(body, bodySize, contentLength);
  }
  else if (bodySize > 0)
  {
    body[0] = '\0';
  }
  sendAt("AT+HTTPTERM", "OK", 1500);
  return actionOk && bodyOk;
}

bool httpPost(const char *url, const char *jsonBody, int &statusCode)
{
  int contentLength = 0;
  if (!beginHttp(url))
  {
    sendAt("AT+HTTPTERM", "OK", 1000);
    return false;
  }

  char command[32];
  snprintf(command, sizeof(command), "AT+HTTPDATA=%u,10000", static_cast<unsigned int>(strlen(jsonBody)));
  if (!sendAt(command, "DOWNLOAD", 5000))
  {
    sendAt("AT+HTTPTERM", "OK", 1000);
    return false;
  }
  modem.write(reinterpret_cast<const uint8_t *>(jsonBody), strlen(jsonBody));
  if (!readModemUntil("OK", 12000, modemResponse, sizeof(modemResponse)))
  {
    sendAt("AT+HTTPTERM", "OK", 1000);
    return false;
  }

  const bool actionOk = readHttpAction(1, statusCode, contentLength);
  sendAt("AT+HTTPTERM", "OK", 1500);
  return actionOk && statusCode >= 200 && statusCode < 300;
}

bool readJsonString(const char *json, const char *key, char *value, size_t valueSize)
{
  char keyPattern[32];
  snprintf(keyPattern, sizeof(keyPattern), "\"%s\":\"", key);
  const char *start = strstr(json, keyPattern);
  if (start == NULL || valueSize == 0)
    return false;
  start += strlen(keyPattern);
  const char *end = strchr(start, '\"');
  if (end == NULL)
    return false;
  size_t length = static_cast<size_t>(end - start);
  if (length >= valueSize)
    length = valueSize - 1;
  memcpy(value, start, length);
  value[length] = '\0';
  return true;
}

void setGateway(uint8_t angle)
{
  angle = constrain(angle, GATE_CLOSED_ANGLE, GATE_OPEN_ANGLE);
  gateServo.write(angle);
  if (angle == GATE_OPEN_ANGLE)
  {
    strcpy(currentGatewayStatus, "OPEN");
  }
  else if (angle == GATE_CLOSED_ANGLE)
  {
    strcpy(currentGatewayStatus, "CLOSED");
  }
  else
  {
    strcpy(currentGatewayStatus, "MOVING");
  }
  delay(700);
  if (angle != GATE_OPEN_ANGLE && angle != GATE_CLOSED_ANGLE)
  {
    strcpy(currentGatewayStatus, "ERROR");
  }
}

void updateLocalIndicators(int sensorValue)
{
  const bool previousState = waterThresholdLatched;
  if (sensorValue >= WATER_ON)
    waterThresholdLatched = true;
  else if (sensorValue <= WATER_OFF)
    waterThresholdLatched = false;

  digitalWrite(RED_LED_PIN, waterThresholdLatched ? HIGH : LOW);
  digitalWrite(GREEN_LED_PIN, waterThresholdLatched ? LOW : HIGH);
  if (!previousState && waterThresholdLatched)
  {
    tone(PIEZO_PIN, 1800, 120);
  }
}

void reportTelemetry(int sensorValue, const char *commandId = NULL)
{
  char url[170];
  char body[280];
  snprintf(url, sizeof(url), "%s/api/telemetry", API_BASE_URL);
  const int gatePct = strcmp(currentGatewayStatus, "OPEN") == 0 ? 100 : strcmp(currentGatewayStatus, "CLOSED") == 0 ? 0
                                                                                                                    : -1;

  if (commandId != NULL && commandId[0] != '\0')
  {
    snprintf(body, sizeof(body),
             "{\"deviceId\":\"%s\",\"sensorValue\":%d,\"gatewayStatus\":\"%s\",\"servoAngle\":%u,\"gatePositionPct\":%d,\"controlMode\":\"%s\",\"commandId\":\"%s\",\"readingValid\":true}",
             DEVICE_ID, sensorValue, currentGatewayStatus, gateServo.read(), gatePct, currentControlMode, commandId);
  }
  else
  {
    snprintf(body, sizeof(body),
             "{\"deviceId\":\"%s\",\"sensorValue\":%d,\"gatewayStatus\":\"%s\",\"servoAngle\":%u,\"gatePositionPct\":%d,\"controlMode\":\"%s\",\"readingValid\":true}",
             DEVICE_ID, sensorValue, currentGatewayStatus, gateServo.read(), gatePct, currentControlMode);
  }

  int statusCode = 0;
  if (!httpPost(url, body, statusCode))
  {
    digitalWrite(RED_LED_PIN, HIGH);
    Serial.print(F("Telemetry HTTP failure, status="));
    Serial.println(statusCode);
    return;
  }
  Serial.print(F("Telemetry accepted, HTTP "));
  Serial.println(statusCode);
}

void pollCommands(int sensorValue)
{
  char url[190];
  char response[MODEM_RESPONSE_CAPACITY];
  snprintf(url, sizeof(url), "%s/api/device/commands?deviceId=%s", API_BASE_URL, DEVICE_ID);
  int statusCode = 0;
  if (!httpGet(url, response, sizeof(response), statusCode) || statusCode != 200)
    return;
  if (strstr(response, "\"command\":null") != NULL)
    return;

  char commandId[40];
  char action[24];
  char requestedMode[16];
  if (!readJsonString(response, "commandId", commandId, sizeof(commandId)))
    return;
  if (!readJsonString(response, "command", action, sizeof(action)))
    return;

  if (strcmp(action, "OPEN_GATE") == 0)
  {
    setGateway(GATE_OPEN_ANGLE);
  }
  else if (strcmp(action, "CLOSE_GATE") == 0)
  {
    setGateway(GATE_CLOSED_ANGLE);
  }
  else if (strcmp(action, "SET_CONTROL_MODE") == 0 &&
           readJsonString(response, "controlMode", requestedMode, sizeof(requestedMode)))
  {
    if (strcmp(requestedMode, "AUTOMATIC") == 0 || strcmp(requestedMode, "MANUAL") == 0)
    {
      strcpy(currentControlMode, requestedMode);
    }
    else
    {
      return;
    }
  }
  else
  {
    return;
  }

  reportTelemetry(sensorValue, commandId);
}

void setup()
{
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(PIEZO_PIN, OUTPUT);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, HIGH);

  Serial.begin(115200);
  modem.begin(MODEM_BAUD);
  gateServo.attach(SERVO_PIN);
  setGateway(GATE_CLOSED_ANGLE);

  if (strlen(DEVICE_API_KEY) < 20 || strstr(API_BASE_URL, "YOUR_PUBLIC_API_HOST") != NULL ||
      strstr(SIM_APN, "YOUR_SIM_APN") != NULL)
  {
    Serial.println(F("Set API_BASE_URL, DEVICE_API_KEY, and SIM_APN before use."));
    digitalWrite(RED_LED_PIN, HIGH);
    return;
  }

  if (!sendAt("AT", "OK", 3000))
  {
    Serial.println(F("No A7670 response. Check UART baud, wiring, and logic levels."));
    digitalWrite(RED_LED_PIN, HIGH);
    return;
  }
  sendAt("ATE0", "OK", 2000);
  sendAt("AT+CFUN=1", "OK", 5000);
  modemReady = waitForNetwork();
  if (!modemReady)
  {
    Serial.println(F("A7670 data connection setup failed."));
    digitalWrite(RED_LED_PIN, HIGH);
    return;
  }

  Serial.println(F("Arduino Uno / A7670 water controller ready."));
  lastTelemetryAt = millis() - TELEMETRY_INTERVAL_MS;
  lastCommandPollAt = millis() - COMMAND_POLL_INTERVAL_MS;
}

void loop()
{
  if (!modemReady)
  {
    delay(1000);
    return;
  }

  const unsigned long now = millis();
  const int sensorValue = analogRead(WATER_SENSOR_PIN);
  updateLocalIndicators(sensorValue);

  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS)
  {
    reportTelemetry(sensorValue);
    lastTelemetryAt = millis();
  }
  if (millis() - lastCommandPollAt >= COMMAND_POLL_INTERVAL_MS)
  {
    pollCommands(sensorValue);
    lastCommandPollAt = millis();
  }
}
