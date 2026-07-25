import { URL, fileURLToPath } from "node:url"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import serverConfig from "./src/server-config.json"
import { attachSignalingRoutes } from "./src/server/server"
import react from "@vitejs/plugin-react"
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
			async configureServer(server) {
				attachSignalingRoutes(server)
			},
			async configurePreviewServer(server) {
				attachSignalingRoutes(server)
			},
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
