import { spawn, type ChildProcess } from "node:child_process"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import logger from "../../utils/logger.ts"
import {
	type CaptureProvider,
	createCaptureProvider,
} from "./captureProvider.ts"
import { resolveGstPaths } from "./gstPaths.ts"
import { RTP_HOST, RTP_PORT } from "../constants.ts"

export class GstManager {
	private process: ChildProcess | null = null
	private provider: CaptureProvider | null = null
	private stopping = false
	private buildPipelineArgs(sourceBlocks: string[]): string[] {
		const args = [...sourceBlocks]

		args.push(
			"!",
			"queue",
			"max-size-buffers=1",
			"leaky=downstream",
			"!",
			"videoconvert",
			"!",
			"videorate",
			"!",
			"video/x-raw,framerate=60/1",
			"!",
			"x264enc",
			"tune=zerolatency",
			"speed-preset=ultrafast",
			"key-int-max=30",
			"byte-stream=false",
			"!",
			"h264parse",
			"!",
			"video/x-h264,profile=baseline",
			"!",
			"rtph264pay",
			"config-interval=-1",
			"pt=96",
			"!",
			"udpsink",
			`host=${RTP_HOST}`,
			`port=${RTP_PORT}`,
			"sync=false",
			"async=false",
		)

		return args
	}

	public async start(): Promise<void> {
		if (this.process || this.stopping) return

		logger.info("Spawning GStreamer UDP engine")

		try {
			this.provider = createCaptureProvider()
			await this.provider.initialize(async (err) => {
				logger.error(`Capture provider failed after startup: ${err.message}`)
				await this.stop()
			})
			const sourceBlocks = await this.provider.getGStreamerSource()
			const pipelineArgs = this.buildPipelineArgs(sourceBlocks)
			this.executePipeline(pipelineArgs)
		} catch (error) {
			logger.error(`Capture initialization failed: ${String(error)}`)
			await this.cleanup()
			throw error
		}
	}

	private executePipeline(pipelineArgs: string[]): void {
		const gst = resolveGstPaths()
		const spawnedEnv = { ...process.env, ...gst.env }
		if (!spawnedEnv.DISPLAY) spawnedEnv.DISPLAY = ":0"
		if (!spawnedEnv.XAUTHORITY) {
			const homeDir = os.homedir()
			const candidates = [
				process.env.XAUTHORITY,
				path.join(homeDir, ".Xauthority"),
				`/run/user/${process.getuid?.() ?? 1000}/Xauthority`,
				`/run/user/${process.getuid?.() ?? 1000}/gdm/Xauthority`,
			].filter(Boolean) as string[]

			for (const candidate of candidates) {
				if (fs.existsSync(candidate)) {
					spawnedEnv.XAUTHORITY = candidate
					logger.info(`Xauthority set: ${candidate}`)
					break
				}
			}
		}

		logger.info(`GStreamer args: gst-launch-1.0 ${pipelineArgs.join(" ")}`)
		this.process = spawn(gst.gstLaunch, pipelineArgs, { env: spawnedEnv })

		this.process.on("error", async (err) => {
			logger.error(`GStreamer spawn failed: ${err.message}`)
			this.process = null
			await this.cleanup()
			return
		})

		this.process.stdout?.on("data", (data: Buffer) => {
			const output = data.toString()
			if (output.includes("State change") && output.includes("PLAYING")) {
				logger.info("GStreamer pipeline running")
			}
		})

		this.process.stderr?.on("data", (data: Buffer) => {
			const logStr = data.toString()
			if (
				logStr.includes("WARN") ||
				logStr.includes("error") ||
				logStr.includes("ERROR")
			) {
				logger.warn(`GStreamer: ${logStr.trim()}`)
			}
		})

		this.process.on("close", async (code) => {
			logger.info(`GStreamer process exited with status: ${code}`)
			this.process = null
			await this.cleanup()
		})
	}

	public async stop(): Promise<void> {
		if (this.process) {
			logger.info("Terminating GStreamer video pipeline")
			const proc = this.process
			this.stopping = true
			await new Promise<void>((resolve) => {
				const killTimer = setTimeout(() => {
					if (proc.exitCode === null) {
						logger.warn(
							"GStreamer process did not exit on SIGTERM, sending SIGKILL",
						)
						proc.kill("SIGKILL")
					}
				}, 2000)
				proc.once("close", () => {
					clearTimeout(killTimer)
					resolve()
				})
				proc.kill("SIGTERM")
			})
			this.process = null
			this.stopping = false
		}
		await this.cleanup()
	}

	private async cleanup(): Promise<void> {
		if (this.provider) {
			await this.provider.dispose()
			this.provider = null
		}
	}
}
