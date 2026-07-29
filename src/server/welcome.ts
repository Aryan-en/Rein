import os from "node:os"
import { i18n } from "../utils/i18n"

const str = i18n.en.server
function getLanIp(): string {
	const ifaces = os.networkInterfaces()
	for (const name of Object.keys(ifaces)) {
		for (const iface of ifaces[name] ?? []) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address
			}
		}
	}
	return "127.0.0.1"
}

export function printWelcome(port: number): void {
	const local = `http://localhost:${port}`
	const network = `http://${getLanIp()}:${port}`
	const debug = `${local}/debug`

	const bold = (t: string) => `\x1b[1m${t}\x1b[0m`
	const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`
	const green = (t: string) => `\x1b[32m${t}\x1b[0m`
	const gray = (t: string) => `\x1b[90m${t}\x1b[0m`

	const divider = gray("────────────────────────────────────────────────────")

	const row = (label: string, value: string, color = green) =>
		`${gray(label.padEnd(10))} ${color(value)}`

	process.stdout.write(
		[
			"",
			`  ${bold(cyan("REIN"))}`,
			`  ${divider}`,
			"",
			`  ${row(str.localLabel, local,cyan)}`,
			`  ${row(str.networkLabel, network)}`,
			`  ${row(str.debugLabel, debug, cyan)}`,
			"",
			`  ${divider}`,
			`  ${gray("Status")}     ${green("Running")}`,
			`  ${gray("Port")}       ${port}`,
			"",
		].join("\n"),
	)
}
