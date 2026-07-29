import type { IncomingMessage, ServerResponse } from "node:http"
import os from "node:os"
import { Transform } from "node:stream"
import logger from "../utils/logger"
import winston from "winston"
import {
	getActiveToken,
	generateToken,
	storeToken,
	isKnownToken,
} from "./tokenStore"
import { GstManager } from "./gstreamer/gstManager"
import { WebRTCManager } from "./webRTC"
import type { InputConfig } from "./types"

let gstManager: GstManager | null = null
let webrtcManager: WebRTCManager | null = null
let hostStatus: "stopped" | "starting" | "running" | "error" = "stopped"
let lastReportedLatencyMs: number | null = null

const sseClients = new Set<ServerResponse>()

const LOG_BUFFER_MAX = 500
const logBuffer: string[] = []

class SseTransport extends winston.transports.Stream {
	constructor() {
		const passthrough = new Transform({
			objectMode: true,
			transform(chunk, _enc, cb) {
				this.push(chunk)
				cb()
			},
		})
		super({ stream: passthrough })
		passthrough.on("data", (info: Record<string, unknown>) => {
			const payload = `data: ${JSON.stringify({
				timestamp: info.timestamp ?? new Date().toISOString(),
				level: String(info.level ?? "info").toUpperCase(),
				message: String(info.message ?? ""),
			})}\n\n`
			// Push to replay buffer
			logBuffer.push(payload)
			if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
			for (const res of sseClients) {
				try {
					res.write(payload)
				} catch {
					sseClients.delete(res)
				}
			}
		})
	}
}

logger.add(new SseTransport())

function getPrimaryIp(): string {
	const interfaces = os.networkInterfaces()
	for (const name of Object.keys(interfaces)) {
		const ifaceList = interfaces[name]
		if (!ifaceList) continue
		for (const iface of ifaceList) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address
			}
		}
	}
	return "127.0.0.1"
}

function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
	return new Promise((resolve, reject) => {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
		})
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : ({} as T))
			} catch (err) {
				reject(err)
			}
		})
		req.on("error", reject)
	})
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	})
	res.end(payload)
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
	const addr = req.socket.remoteAddress
	const isLocal =
		addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
	if (isLocal) return true

	const authHeader = req.headers.authorization ?? ""
	let token = authHeader.startsWith("Bearer ")
		? authHeader.slice(7).trim()
		: null

	if (!token) {
		const url = new URL(req.url ?? "", `http://${req.headers.host}`)
		token = url.searchParams.get("token")
	}

	if (!token || !isKnownToken(token)) {
		json(res, 401, { error: "Unauthorized" })
		return false
	}
	return true
}

// biome-ignore lint/suspicious/noExplicitAny: Vite server instance
export function attachSignalingRoutes(server: any): void {
	const httpServer = server.httpServer || server

	if (!webrtcManager && httpServer) {
		webrtcManager = new WebRTCManager(httpServer)
	}

	if (!gstManager) {
		gstManager = new GstManager()
		hostStatus = "starting"
		gstManager
			.start()
			.then(() => {
				hostStatus = "running"
				logger.info("GStreamer capture engine started")
			})
			.catch((err) => {
				logger.error(`Failed to start GStreamer capture engine: ${err}`)
				hostStatus = "error"
			})
	}

	const handleApiRequest = (
		req: IncomingMessage,
		res: ServerResponse,
		next?: () => void,
	) => {
		const pathname = new URL(
			req.url ?? "",
			`http://${req.headers.host ?? "localhost"}`,
		).pathname

		if (!pathname.startsWith("/api/")) {
			if (next) next()
			return
		}

		if (pathname === "/api/host/start" && req.method === "POST") {
			if (!requireAuth(req, res)) return
			if (hostStatus === "running") {
				json(res, 200, { status: hostStatus })
				return
			}
			hostStatus = "starting"
			if (!gstManager) gstManager = new GstManager()
			gstManager
				.start()
				.then(() => {
					hostStatus = "running"
				})
				.catch((err) => {
					logger.error(`Failed to start GStreamer: ${err}`)
					hostStatus = "error"
				})

			json(res, 200, { status: hostStatus })
			return
		}

		if (pathname === "/api/host/stop" && req.method === "POST") {
			if (!requireAuth(req, res)) return
			if (gstManager) {
				gstManager.stop()
			}
			hostStatus = "stopped"
			json(res, 200, { status: hostStatus })
			return
		}

		if (pathname === "/api/host/status" && req.method === "GET") {
			if (!requireAuth(req, res)) return
			json(res, 200, { status: hostStatus })
			return
		}

		if (pathname === "/api/host/ip" && req.method === "GET") {
			if (!requireAuth(req, res)) return
			json(res, 200, { ip: getPrimaryIp() })
			return
		}

		if (pathname === "/api/auth/token" && req.method === "POST") {
			const addr = req.socket.remoteAddress
			const isLocal =
				addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
			if (!isLocal) {
				json(res, 403, { error: "Localhost only" })
				return
			}
			let token = getActiveToken()
			if (!token) {
				token = generateToken()
				storeToken(token)
			}
			json(res, 200, { token })
			return
		}

		if (pathname === "/api/config" && req.method === "POST") {
			if (!requireAuth(req, res)) return
			parseJsonBody<Partial<InputConfig>>(req)
				.then((config) => {
					if (webrtcManager) {
						webrtcManager.updateConfig(config)
					}
					json(res, 200, { ok: true })
				})
				.catch((err) => {
					json(res, 400, { ok: false, error: String(err) })
				})
			return
		}

		if (pathname === "/api/debug/sessions" && req.method === "GET") {
			const sessions = webrtcManager?.getSessions() ?? []
			const inputConnectionCount = sessions.filter(
				(s) => s.hasInputConnection,
			).length
			json(res, 200, {
				hostStatus,
				sessionCount: sessions.length,
				sessions,
				inputConnectionCount,
				latencyMs: lastReportedLatencyMs,
			})
			return
		}

		if (pathname === "/api/debug/report-latency" && req.method === "POST") {
			parseJsonBody<{ latencyMs?: number }>(req)
				.then((body) => {
					if (typeof body.latencyMs === "number" && body.latencyMs >= 0) {
						lastReportedLatencyMs = body.latencyMs
					}
					json(res, 200, { ok: true })
				})
				.catch(() => json(res, 400, { ok: false }))
			return
		}

		if (pathname === "/api/debug/logs" && req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			})
			res.write(": connected\n\n")
			// Replay buffered logs so the client sees history from before opening /debug
			for (const entry of logBuffer) {
				try {
					res.write(entry)
				} catch {
					/* client gone already */
				}
			}
			sseClients.add(res)
			req.on("close", () => sseClients.delete(res))
			req.on("error", () => sseClients.delete(res))
			return
		}

		json(res, 404, { error: "API endpoint not found" })
	}

	if (server.middlewares) {
		server.middlewares.use(handleApiRequest)
	} else if (httpServer && typeof httpServer.on === "function") {
		httpServer.on("request", handleApiRequest)
	}

	logger.info("Signaling HTTP routes and WebSocket attached")
}

export function stopServer() {
	if (webrtcManager) webrtcManager.shutdown()
	if (gstManager) gstManager.stop()
}
