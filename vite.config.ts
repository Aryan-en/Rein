import { URL, fileURLToPath } from "node:url"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import serverConfig from "./src/server-config.json"
import { attachSignalingRoutes } from "./src/server/server"
import { printWelcome } from "./src/server/welcome"
import react from "@vitejs/plugin-react"
// biome-ignore lint/suspicious/noExplicitAny: Vite server instance
const wireServer = (server: any) => {
	attachSignalingRoutes(server)
	server.httpServer?.once("listening", () => {
		const addr = server.httpServer?.address()
		const port =
			addr && typeof addr === "object" ? addr.port : serverConfig.frontendPort
		printWelcome(port)
	})
}

const config = defineConfig({
	base: "/",
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	plugins: [
		{
			name: "rein-server",
			configureServer: wireServer,
			configurePreviewServer: wireServer,
		},
		devtools(),
		nitro(),
		tanstackStart(),
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", {}]],
			},
		}),
	],
	ssr: {
		external: ["dbus-next", "eventsource", "werift"],
		noExternal: ["tailwindcss", "@tailwindcss/postcss"],
	},
	server: {
		host: serverConfig.host === "0.0.0.0" ? true : serverConfig.host,
		port: serverConfig.frontendPort,
	},
	build: {
		rollupOptions: {
			external: ["werift"],
		},
	},
})

export default config
