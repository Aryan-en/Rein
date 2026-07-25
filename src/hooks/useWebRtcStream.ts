"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useConnection } from "../contexts/ConnectionProvider"

interface UseWebRtcStreamOptions {
	token: string | null
}
const MAX_RETRIES = 5

export function useWebRtcStream({ token }: UseWebRtcStreamOptions) {
	const [trackActive, setTrackActive] = useState(false)
	const [videoStream, setVideoStream] = useState<MediaStream | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [errorHandle, setErrorHandle] = useState<string | null>(null)
	const [reconnectAttempt, setReconnectAttempt] = useState(0)
	const { registerDataChannel, send: sendInputEvent } = useConnection()

	const pcRef = useRef<RTCPeerConnection | null>(null)
	const wsRef = useRef<WebSocket | null>(null)
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const trackActiveRef = useRef(false)
	const retryCountRef = useRef(0)
	const isRetryingRef = useRef(false)

	useEffect(() => {
		trackActiveRef.current = trackActive
	}, [trackActive])

	useEffect(() => {
		return () => {
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current)
			}
		}
	}, [])

	const triggerRetry = useCallback(() => {
		if (retryTimerRef.current || isRetryingRef.current) return
		isRetryingRef.current = true

		if (retryCountRef.current >= MAX_RETRIES) {
			console.warn(
				`[WebRTC] Max retry attempts (${MAX_RETRIES}) reached. Stopping retries.`,
			)
			setErrorHandle("Connection Failed")
			setError("Failed to establish stream session after multiple attempts")
			isRetryingRef.current = false
			return
		}

		if (wsRef.current) {
			try {
				wsRef.current.close()
			} catch {}
			wsRef.current = null
		}
		if (pcRef.current) {
			try {
				pcRef.current.close()
			} catch {}
			pcRef.current = null
		}

		setTrackActive(false)
		setVideoStream(null)

		const backoffDelay = Math.min(2000 * 2 ** retryCountRef.current, 30000)

		console.log(
			`[WebRTC] Transient network failure, retrying automatically (attempt ${retryCountRef.current + 1}/${MAX_RETRIES}) in ${backoffDelay / 1000} seconds...`,
		)
		retryTimerRef.current = setTimeout(() => {
			retryTimerRef.current = null
			isRetryingRef.current = false
			retryCountRef.current += 1
			setReconnectAttempt((prev) => prev + 1)
		}, backoffDelay)
	}, [])

	const handleNetworkFailure = useCallback(() => {
		triggerRetry()
	}, [triggerRetry])

	const reconnect = () => {
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current)
			retryTimerRef.current = null
		}
		isRetryingRef.current = false
		if (wsRef.current) {
			try {
				wsRef.current.close()
			} catch {}
			wsRef.current = null
		}
		if (pcRef.current) {
			try {
				pcRef.current.close()
			} catch {}
			pcRef.current = null
		}
		setErrorHandle(null)
		setError(null)
		setTrackActive(false)
		setVideoStream(null)
		retryCountRef.current = 0
		setReconnectAttempt((prev) => prev + 1)
	}

	useEffect(() => {
		if (!token) return

		let isDisposed = false

		if (reconnectAttempt > 0) {
			console.log(
				`[WebRTC] Re-establishing WebRTC session (attempt ${reconnectAttempt})...`,
			)
		}

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
		const wsUrl = `${protocol}//${window.location.host}/ws`
		const ws = new WebSocket(wsUrl)
		wsRef.current = ws

		const pc = new RTCPeerConnection({
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
			bundlePolicy: "max-bundle",
		})
		pcRef.current = pc

		let dcUnordered: RTCDataChannel | null = null
		let dcOrdered: RTCDataChannel | null = null

		pc.ontrack = (event) => {
			if (isDisposed || isRetryingRef.current) return
			if (event.track.kind === "video" && event.streams[0]) {
				setVideoStream(event.streams[0])
				setTrackActive(true)
				retryCountRef.current = 0
			}
		}

		pc.ondatachannel = (event) => {
			if (isDisposed || isRetryingRef.current) return
			const channel = event.channel
			if (channel.label === "input-unordered") {
				dcUnordered = channel
			} else if (channel.label === "input-ordered") {
				dcOrdered = channel
			}

			if (dcUnordered && dcOrdered) {
				registerDataChannel(dcUnordered, dcOrdered)
			}
		}

		pc.onicecandidate = (event) => {
			if (isDisposed || isRetryingRef.current) return
			if (event.candidate && ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({ type: "ice", candidate: event.candidate.toJSON() }),
				)
			}
		}

		pc.onconnectionstatechange = () => {
			if (isDisposed || isRetryingRef.current) return
			if (
				pc.connectionState === "failed" ||
				pc.connectionState === "disconnected"
			) {
				handleNetworkFailure()
			}
		}

		const iceQueue: RTCIceCandidateInit[] = []

		ws.onmessage = async (event) => {
			if (isDisposed || isRetryingRef.current) return
			try {
				const msg = JSON.parse(event.data)
				if (msg.type === "offer") {
					await pc.setRemoteDescription(msg.sdp)
					const answer = await pc.createAnswer()
					await pc.setLocalDescription(answer)
					ws.send(JSON.stringify({ type: "answer", sdp: answer }))

					while (iceQueue.length > 0) {
						const cand = iceQueue.shift()
						if (cand) {
							await pc
								.addIceCandidate(new RTCIceCandidate(cand))
								.catch(() => {})
						}
					}
				} else if (msg.type === "ice" && msg.candidate) {
					if (pc.remoteDescription) {
						await pc
							.addIceCandidate(new RTCIceCandidate(msg.candidate))
							.catch(() => {})
					} else {
						iceQueue.push(msg.candidate)
					}
				} else if (msg.type === "error") {
					console.error("[WebRTC] Host error received:", msg)
					setErrorHandle(msg.errorType || "Host Error")
					setError(msg.message || "Host reported an error")
				}
			} catch (err) {
				if (!isDisposed && !isRetryingRef.current) {
					console.error("[WebRTC] WebSocket message handling failed:", err)
					handleNetworkFailure()
				}
			}
		}

		ws.onerror = (error) => {
			if (isDisposed || isRetryingRef.current) return
			console.error("[WebRTC] WebSocket error:", error)
			handleNetworkFailure()
		}

		ws.onclose = () => {
			if (isDisposed || isRetryingRef.current) return
			console.warn("[WebRTC] WebSocket closed")
			handleNetworkFailure()
		}

		let lastBytesReceived = 0
		let lastBytesTime = Date.now()

		const statsInterval = setInterval(async () => {
			if (isDisposed || isRetryingRef.current || !trackActiveRef.current) return
			try {
				const stats = await pc.getStats()
				let videoInbound = null
				for (const report of stats.values()) {
					if (report.type === "inbound-rtp" && report.kind === "video") {
						videoInbound = report
						break
					}
				}
				if (videoInbound) {
					const bytes = videoInbound.bytesReceived
					const now = Date.now()
					if (bytes > lastBytesReceived) {
						lastBytesReceived = bytes
						lastBytesTime = now
					} else if (now - lastBytesTime > 15000) {
						console.warn(
							"[WebRTC] Video stream freeze detected, reconnecting...",
						)
						handleNetworkFailure()
					}
				}
			} catch (err) {
				console.error("[WebRTC] Failed to fetch stats:", err)
			}
		}, 2000)

		return () => {
			isDisposed = true
			clearInterval(statsInterval)
			try {
				ws.close()
			} catch {}
			try {
				pc.close()
			} catch {}
			setTrackActive(false)
			setVideoStream(null)
		}
	}, [token, registerDataChannel, handleNetworkFailure, reconnectAttempt])

	return {
		trackActive,
		videoStream,
		error,
		errorHandle,
		reconnect,
		sendInputEvent,
	}
}
