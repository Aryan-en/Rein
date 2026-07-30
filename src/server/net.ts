import os from "node:os"

export function getLanIp(): string {
	const ifaces = os.networkInterfaces()
	for (const name of Object.keys(ifaces)) {
		const list = ifaces[name]
		if (!list) continue
		for (const iface of list) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address
			}
		}
	}
	return "127.0.0.1"
}
