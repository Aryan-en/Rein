import {
	MediaStreamTrack,
	RTCPeerConnection,
	RTCRtpCodecParameters,
	type RTCDataChannel,
} from "werift"
import { WebSocketServer, WebSocket } from "ws"
import dgram from "node:dgram"
import crypto from "node:crypto"
import { InputHandler } from "./InputHandler"
import logger from "../utils/logger"
import type { InputMessage, InputConfig } from "./types"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { isKnownToken } from "./tokenStore"
import { RTP_HOST, RTP_PORT } from "./constants"

interface ClientSession {
	ws: WebSocket
	pc: RTCPeerConnection
	videoTrack: MediaStreamTrack
	inputHandler: InputHandler
	sessionId: string
	bytesRecv: number
	bytesSent: number
	dcUnordered: RTCDataChannel
	dcOrdered: RTCDataChannel
}

import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import type { EventEmitter } from "node:events"

export interface SessionSnapshot {
	id: string
	state: string
	createdAt: number
	sseViewerCount: number
	hasInputConnection: boolean
	bytesRecv: number
	bytesSent: number
}

export class WebRTCManager {
	private wss: WebSocketServer
	private udpSocket: dgram.Socket
	private serverRef: EventEmitter
	private upgradeHandler: (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void
	private clients = new Map<string, ClientSession>()
	private sessionCreatedAt = new Map<string, number>()

	constructor(server: EventEmitter) {
		this.wss = new WebSocketServer({ noServer: true })
		this.udpSocket = dgram.createSocket("udp4")
		this.serverRef = server

		this.upgradeHandler = (
			request: IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => {
			try {
				const url = new URL(
					request.url || "",
					`http://${request.headers.host || "localhost"}`,
				)
				if (url.pathname === "/ws") {
					const addr = request.socket.remoteAddress
					const isLocal =
						addr === "127.0.0.1" ||
						addr === "::1" ||
						addr === "::ffff:127.0.0.1"
					const token = url.searchParams.get("token")
					if (!isLocal && (!token || !isKnownToken(token))) {
						socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
						socket.destroy()
						return
					}
					this.wss.handleUpgrade(request, socket, head, (ws) => {
						this.wss.emit("connection", ws, request)
					})
				}
			} catch (_err) {
				// Ignore invalid URLs or non-matching upgrades
			}
		}

		this.serverRef.on("upgrade", this.upgradeHandler)

		this.setupUdpSocket()
		this.setupWebSocketServer()
	}

	private setupUdpSocket() {
		this.udpSocket.on("error", (err) => {
			logger.error(`UDP socket error:\n${err.stack}`)
			try {
				this.udpSocket.close()
			} catch {}
		})

		this.udpSocket.on("message", (msg) => {
			for (const client of this.clients.values()) {
				try {
					client.videoTrack.writeRtp(msg)
					client.bytesSent += msg.length
				} catch (_err) {
					// Ignore individual track write errors
				}
			}
		})

		this.udpSocket.bind(RTP_PORT, RTP_HOST, () => {
			logger.info(
				`UDP socket listening for RTP packets on ${RTP_HOST}:${RTP_PORT}`,
			)
		})
	}

	private getInitialConfig(): Partial<InputConfig> {
		try {
			const configPath = fileURLToPath(
				new URL("../server-config.json", import.meta.url),
			)
			if (fs.existsSync(configPath)) {
				const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"))
				return {
					sensitivity:
						typeof cfg.sensitivity === "number" ? cfg.sensitivity : 1.0,
					invertScroll:
						typeof cfg.invertScroll === "boolean" ? cfg.invertScroll : false,
				}
			}
		} catch (e) {
			logger.warn(
				`Failed to read initial config from server-config.json: ${String(e)}`,
			)
		}
		return { sensitivity: 1.0, invertScroll: false }
	}

	private setupWebSocketServer() {
		this.wss.on("connection", async (ws) => {
			const sessionId = crypto.randomUUID()
			this.sessionCreatedAt.set(sessionId, Date.now())
			logger.info(`Viewer connected via WebSocket: ${sessionId}`)

			const pc = new RTCPeerConnection({
				iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
				codecs: {
					video: [
						new RTCRtpCodecParameters({
							mimeType: "video/H264",
							clockRate: 90000,
							payloadType: 96,
							rtcpFeedback: [
								{ type: "nack" },
								{ type: "nack", parameter: "pli" },
								{ type: "goog-remb" },
							],
						}),
					],
				},
			})
			const videoTrack = new MediaStreamTrack({
				kind: "video",
			})
			pc.addTrack(videoTrack)

			const inputHandler = new InputHandler(
				this.getInitialConfig(),
				8,
				(errorType, message) => {
					logger.error(`InputHandler error: ${errorType} - ${message}`)
					try {
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(
								JSON.stringify({
									type: "error",
									errorType,
									message,
								}),
							)
						}
					} catch (e) {
						logger.error(
							`Failed to transmit error frame to client: ${String(e)}`,
						)
					}
				},
			)

			const dcUnordered = pc.createDataChannel("input-unordered", {
				ordered: false,
				maxRetransmits: 0,
			})
			const dcOrdered = pc.createDataChannel("input-ordered", { ordered: true })

			const handleDataMessage = (dc: RTCDataChannel, msg: Buffer | string) => {
				try {
					const raw = typeof msg === "string" ? msg : msg.toString()
					const session = this.clients.get(sessionId)
					if (session) session.bytesRecv += raw.length
					const parsed = JSON.parse(raw)
					if (parsed.type === "ping") {
						const pong = JSON.stringify({
							type: "pong",
							timestamp: parsed.timestamp,
						})
						if (dc.readyState === "open") {
							dc.send(pong)
						}
						return
					}
					inputHandler.handleMessage(parsed as InputMessage).catch((err) => {
						logger.error(`Input handler processing error: ${String(err)}`)
					})
				} catch (err) {
					logger.error(`Input parse error: ${String(err)}`)
				}
			}

			dcUnordered.onMessage.subscribe((msg) =>
				handleDataMessage(dcUnordered, msg),
			)
			dcOrdered.onMessage.subscribe((msg) => handleDataMessage(dcOrdered, msg))

			const client: ClientSession = {
				ws,
				pc,
				videoTrack,
				inputHandler,
				sessionId,
				bytesRecv: 0,
				bytesSent: 0,
				dcUnordered,
				dcOrdered,
			}
			this.clients.set(sessionId, client)

			pc.iceConnectionStateChange.subscribe((state) => {
				logger.info(`WebRTC ICE state for ${sessionId}: ${state}`)
				if (state === "failed" || state === "closed") {
					this.cleanupClient(sessionId)
				}
			})

			pc.onIceCandidate.subscribe((candidate) => {
				if (candidate && ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({ type: "ice", candidate: candidate.toJSON() }),
					)
				}
			})

			ws.on("message", async (data) => {
				try {
					const msg = JSON.parse(data.toString())
					if (msg.type === "answer") {
						await pc.setRemoteDescription(msg.sdp)
					} else if (msg.type === "ice" && msg.candidate) {
						await pc.addIceCandidate(msg.candidate)
					} else if (msg.type === "ping" && ws.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ type: "pong" }))
					}
				} catch (err) {
					logger.error(`WebSocket message handling error: ${String(err)}`)
				}
			})

			ws.on("close", () => {
				this.cleanupClient(sessionId)
			})

			try {
				const offer = await pc.createOffer()
				await pc.setLocalDescription(offer)
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "offer", sdp: offer }))
				}
			} catch (err) {
				logger.error(`Failed to create offer: ${String(err)}`)
				this.cleanupClient(sessionId)
			}
		})
	}

	private cleanupClient(sessionId: string) {
		const client = this.clients.get(sessionId)
		if (client) {
			logger.info(`Cleaning up client session: ${sessionId}`)
			try {
				client.pc.close()
			} catch (_e) {}
			try {
				client.inputHandler.destroy()
			} catch (_e) {}
			this.clients.delete(sessionId)
			this.sessionCreatedAt.delete(sessionId)
		}
	}
	public getSessions(): SessionSnapshot[] {
		const snapshots: SessionSnapshot[] = []
		for (const [id, client] of this.clients) {
			const hasInputConnection =
				client.dcUnordered.readyState === "open" ||
				client.dcOrdered.readyState === "open"
			snapshots.push({
				id,
				state: client.pc.iceConnectionState ?? "new",
				createdAt: this.sessionCreatedAt.get(id) ?? Date.now(),
				sseViewerCount: client.ws.readyState === WebSocket.OPEN ? 1 : 0,
				hasInputConnection,
				bytesRecv: client.bytesRecv,
				bytesSent: client.bytesSent,
			})
		}
		return snapshots
	}

	public updateConfig(config: Partial<InputConfig>) {
		for (const client of this.clients.values()) {
			client.inputHandler.updateConfig(config)
		}
	}

	public shutdown() {
		if (this.serverRef && typeof this.serverRef.off === "function") {
			this.serverRef.off("upgrade", this.upgradeHandler)
		}
		this.wss.close()
		try {
			this.udpSocket.close()
		} catch {}
		for (const sessionId of this.clients.keys()) {
			this.cleanupClient(sessionId)
		}
	}
}
