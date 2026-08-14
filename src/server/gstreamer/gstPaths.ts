/**
 * GStreamer path resolution.
 *
 * Resolves the path to `gst-launch-1.0` and the required environment variables
 * for running a GStreamer pipeline. Prefers the locally bundled GStreamer
 * install at `<project-root>/bin/gstreamer/` (or Electron resources folder in prod)
 * and falls back to the system-installed GStreamer.
 *
 * Can be configured via `src/server-config.json` with `useSystemGstreamer: true`
 * to force using the global system-installed GStreamer instead of local bundled binaries.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import logger from "../../utils/logger"

function resolveProjectRoot(): string {
	const currentFile = fileURLToPath(import.meta.url)
	let dir = path.dirname(currentFile)
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir
		}
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return process.cwd()
}

const PROJECT_ROOT = resolveProjectRoot()

const GST_LAUNCH =
	os.platform() === "win32" ? "gst-launch-1.0.exe" : "gst-launch-1.0"

const GST_INSPECT =
	os.platform() === "win32" ? "gst-inspect-1.0.exe" : "gst-inspect-1.0"

export interface GstPaths {
	/** Absolute path to the `gst-launch-1.0` executable. */
	gstLaunch: string
	/** Absolute path to `gst-inspect-1.0` (useful for diagnostics). */
	gstInspect: string
	/** Whether we are using the locally bundled GStreamer. */
	isBundled: boolean
	/** Environment variables to set when running GStreamer. */
	env: Record<string, string>
}

export interface ServerConfig {
	host?: string
	frontendPort?: number
	address?: string
	inputThrottleMs?: number
	sensitivity?: number
	invertScroll?: boolean
	verboseLogs?: boolean
	useSystemGstreamer?: boolean
	useGlobalGstreamer?: boolean
	disableBundledGstreamer?: boolean
}

import { loadServerConfig as readServerConfig } from "../../utils/configHelper"

/**
 * Loads server configuration from server-config.json if available.
 */
function loadServerConfig(): ServerConfig {
	return readServerConfig() as ServerConfig
}

/**
 * Finds the bundled GStreamer root folder in dev or Electron production environments.
 */
function getBundledGstreamerRoot(): string | null {
	const candidates: string[] = []

	// Electron production resources path (electron-builder extraResources)
	const resourcesPath = (process as unknown as { resourcesPath?: string })
		.resourcesPath
	if (resourcesPath) {
		candidates.push(
			path.join(resourcesPath, "bin", "gstreamer"),
			path.join(resourcesPath, "gstreamer"),
		)
	}

	// Local development project root
	candidates.push(path.join(PROJECT_ROOT, "bin", "gstreamer"))

	// Fallback to process.cwd()
	candidates.push(path.join(process.cwd(), "bin", "gstreamer"))

	for (const candidate of candidates) {
		const exe = path.join(candidate, "bin", GST_LAUNCH)
		if (fs.existsSync(exe)) {
			return candidate
		}
	}

	return null
}

function bundledPaths(bundledRoot: string): GstPaths {
	const binDir = path.join(bundledRoot, "bin")
	const libDir = path.join(bundledRoot, "lib")
	const pluginDir = path.join(libDir, "gstreamer-1.0")
	const pluginScannerDir = path.join(bundledRoot, "libexec", "gstreamer-1.0")

	let registryPath = path.join(bundledRoot, "registry.bin")
	try {
		fs.accessSync(bundledRoot, fs.constants.W_OK)
	} catch {
		registryPath = path.join(os.tmpdir(), "rein-gstreamer-registry.bin")
	}

	const env: Record<string, string> = {
		GST_PLUGIN_PATH: pluginDir,
		GST_PLUGIN_SCANNER: path.join(
			pluginScannerDir,
			os.platform() === "win32"
				? "gst-plugin-scanner.exe"
				: "gst-plugin-scanner",
		),
		GST_REGISTRY: registryPath,
	}

	if (os.platform() === "win32") {
		const existingPath = process.env.PATH ?? ""
		env.PATH = `${binDir};${libDir};${existingPath}`
	} else if (os.platform() === "linux") {
		const existingLdPath = process.env.LD_LIBRARY_PATH ?? ""
		env.LD_LIBRARY_PATH = existingLdPath
			? `${libDir}:${binDir}:${existingLdPath}`
			: `${libDir}:${binDir}`
	} else if (os.platform() === "darwin") {
		const existingDyldPath = process.env.DYLD_LIBRARY_PATH ?? ""
		env.DYLD_LIBRARY_PATH = existingDyldPath
			? `${libDir}:${existingDyldPath}`
			: libDir
	}

	const bundledInspect = path.join(binDir, GST_INSPECT)
	const gstInspect = fs.existsSync(bundledInspect)
		? bundledInspect
		: GST_INSPECT

	return {
		gstLaunch: path.join(binDir, GST_LAUNCH),
		gstInspect,
		isBundled: true,
		env,
	}
}

function systemPaths(): GstPaths {
	return {
		gstLaunch: GST_LAUNCH, // rely on PATH
		gstInspect: GST_INSPECT,
		isBundled: false,
		env: {},
	}
}

export function resolveGstPaths(): GstPaths {
	const config = loadServerConfig()

	// Check if local bundled GStreamer is disabled via server-config.json
	const isSystemDisabled =
		config.useSystemGstreamer === true ||
		config.useGlobalGstreamer === true ||
		config.disableBundledGstreamer === true

	if (isSystemDisabled) {
		logger.info(
			"Bundled GStreamer disabled in server-config.json — using system-installed GStreamer",
		)
		return systemPaths()
	}

	const bundledRoot = getBundledGstreamerRoot()
	if (bundledRoot) {
		logger.info(`Using bundled GStreamer at ${bundledRoot}`)
		return bundledPaths(bundledRoot)
	}

	logger.info(
		"Bundled GStreamer not found — falling back to system-installed GStreamer",
	)
	return systemPaths()
}
