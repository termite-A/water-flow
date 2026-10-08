import type { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import mqtt, { type MqttClient } from 'mqtt'
import type { Pool } from 'pg'
import { findAdminSession } from './auth.js'

type DeviceMessageHandler = (topic: string, payload: unknown) => Promise<void>

export class RealtimeHub {
  private readonly sockets = new WebSocketServer({ noServer: true })
  private readonly mqttClient: MqttClient | null
  private lastMqttErrorLoggedAt = 0

  constructor(server: Server, pool: Pool, onDeviceMessage: DeviceMessageHandler) {
    server.on('upgrade', (request, socket, head) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (requestUrl.pathname !== '/api/ws') {
        socket.destroy()
        return
      }
      if (request.headers.origin !== (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')) {
        socket.destroy()
        return
      }

      void findAdminSession(pool, request.headers.cookie).then((admin) => {
        if (!admin) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        this.sockets.handleUpgrade(request, socket, head, (websocket) => {
          this.sockets.emit('connection', websocket, request)
          websocket.send(JSON.stringify({ type: 'connection', status: 'authenticated' }))
        })
      }).catch(() => socket.destroy())
    })

    this.mqttClient = process.env.MQTT_URL
      ? mqtt.connect(process.env.MQTT_URL, {
          username: process.env.MQTT_USERNAME,
          password: process.env.MQTT_PASSWORD,
          reconnectPeriod: 5000,
          connectTimeout: 10000,
        })
      : null

    this.mqttClient?.on('connect', () => {
      this.broadcast({ type: 'mqtt', status: 'connected' })
      this.mqttClient?.subscribe([
        'waterflow/device/+/status',
        'waterflow/device/+/water-level',
        'waterflow/device/+/gateway',
        'waterflow/device/+/events',
      ], { qos: 1 })
    })
    this.mqttClient?.on('reconnect', () => this.broadcast({ type: 'mqtt', status: 'reconnecting' }))
    this.mqttClient?.on('offline', () => this.broadcast({ type: 'mqtt', status: 'offline' }))
    this.mqttClient?.on('error', (error) => {
      const now = Date.now()
      if (now - this.lastMqttErrorLoggedAt >= 60000) {
        this.lastMqttErrorLoggedAt = now
        console.error('MQTT connection error; retrying:', error.message || 'No detail provided by client.')
      }
      this.broadcast({ type: 'mqtt', status: 'error' })
    })
    this.mqttClient?.on('message', (topic, message) => {
      try {
        const payload: unknown = JSON.parse(message.toString())
        void onDeviceMessage(topic, payload).catch((error) => {
          console.error(`Failed to process MQTT message from ${topic}:`, error)
        })
      } catch (error) {
        console.error('Ignored malformed MQTT message:', error)
      }
    })
  }

  get mqttStatus() {
    if (!this.mqttClient) return 'not-configured'
    return this.mqttClient.connected ? 'connected' : 'offline'
  }

  broadcast(message: unknown) {
    const encoded = JSON.stringify(message)
    for (const socket of this.sockets.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded)
    }
  }

  async publishCommand(deviceCode: string, command: Record<string, unknown>) {
    if (!this.mqttClient?.connected) return false
    const topic = `waterflow/device/${encodeURIComponent(deviceCode)}/command`
    await new Promise<void>((resolve, reject) => {
      this.mqttClient?.publish(topic, JSON.stringify(command), { qos: 1 }, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    return true
  }

  async close() {
    this.sockets.clients.forEach((socket) => socket.close(1001, 'Server shutting down'))
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()))
    if (this.mqttClient) {
      await new Promise<void>((resolve) => this.mqttClient?.end(false, {}, () => resolve()))
    }
  }
}
