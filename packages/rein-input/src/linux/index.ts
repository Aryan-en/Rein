import { UinputDevice } from "@imxade/inject/linux"
import {
	EV_SYN,
	EV_KEY,
	EV_REL,
	EV_ABS,
	REL_X,
	REL_Y,
	REL_WHEEL,
	REL_HWHEEL,
	BTN_LEFT,
	BTN_RIGHT,
	BTN_MIDDLE,
	BTN_TOUCH,
	BTN_TOOL_FINGER,
	BTN_TOOL_DOUBLETAP,
	BTN_TOOL_TRIPLETAP,
	BTN_TOOL_QUADTAP,
	ABS_MT_SLOT,
	ABS_MT_TRACKING_ID,
	ABS_MT_POSITION_X,
	ABS_MT_POSITION_Y,
	ABS_MT_TOUCH_MAJOR,
	ABS_MT_PRESSURE,
	ABS_X,
	ABS_Y,
	MAX_CONTACTS,
	KEY_PRESS,
	KEY_RELEASE,
} from "./constants"
import { WHEEL_SCALE, DEFAULT_CONFIG } from "../constants"
import { LinuxKeyboard } from "./keyboard"
import { LinuxTouch } from "./touch"
import { LINUX_KEY_MAP } from "../keyMap"
import type {
	InputConfig,
	PlatformInjector,
	TouchContact,
	MouseButton,
} from "../types"

const DEVICE_IDENTITY = {
	bustype: 0x03, // BUS_USB
	vendor: 0x1234,
	product: 0x5678,
	version: 1,
}

export class LinuxInputInjector implements PlatformInjector {
	private config: InputConfig
	private mouseDev: UinputDevice | null = null
	private kbDev: UinputDevice | null = null
	private touchDev: UinputDevice | null = null
	private keyboard: LinuxKeyboard | null = null
	private touch: LinuxTouch | null = null
	private initialized = false

	constructor(config: Partial<InputConfig> = {}) {
		if (process.platform !== "linux") {
			throw new Error("LinuxInputInjector can only be used on Linux")
		}
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.initialize()
		if (!this.initialized) {
			throw new Error(
				"Linux virtual input devices failed to initialize (check /dev/uinput permissions)",
			)
		}
	}

	updateConfig(config: Partial<InputConfig>): void {
		this.config = { ...this.config, ...config }
	}

	injectMouseMove(dx: number, dy: number): void {
		if (!this.initialized || !this.mouseDev || (dx === 0 && dy === 0)) return

		this.mouseDev
			.emit(EV_REL, REL_X, Math.round(dx))
			.emit(EV_REL, REL_Y, Math.round(dy))
			.sync()
	}

	injectMouseButton(button: MouseButton, isDown: boolean): void {
		if (!this.initialized || !this.mouseDev) return

		const codeMap: Record<MouseButton, number> = {
			left: BTN_LEFT,
			right: BTN_RIGHT,
			middle: BTN_MIDDLE,
		}
		const code = codeMap[button]

		this.mouseDev.emit(EV_KEY, code, isDown ? KEY_PRESS : KEY_RELEASE).sync()
	}

	injectMouseWheel(dx: number, dy: number): void {
		if (!this.initialized || !this.mouseDev) return

		const invert = this.config.invertScroll ? -1 : 1

		if (dy !== 0) {
			const amount = Math.round(dy * invert * WHEEL_SCALE)
			this.mouseDev.emit(EV_REL, REL_WHEEL, amount)
		}
		if (dx !== 0) {
			const amount = Math.round(dx * invert * WHEEL_SCALE)
			this.mouseDev.emit(EV_REL, REL_HWHEEL, amount)
		}
		this.mouseDev.sync()
	}

	injectKey(key: string, pos?: string): void {
		this.keyboard?.injectKey(key, pos ?? "")
	}

	injectCombo(keys: string[]): void {
		this.keyboard?.injectCombo(keys)
	}

	injectText(text: string): void {
		this.keyboard?.injectText(text)
	}

	injectTouch(contacts: TouchContact[]): void {
		this.touch?.injectTouch(contacts)
	}

	destroy(): void {
		try {
			this.touch?.releaseAll()
		} catch (err) {
			console.error("[LinuxInputInjector] Error during touch releaseAll:", err)
		}

		try {
			this.mouseDev?.destroy()
		} catch (err) {
			console.error("[LinuxInputInjector] Error destroying mouseDev:", err)
		}
		this.mouseDev = null

		try {
			this.kbDev?.destroy()
		} catch (err) {
			console.error("[LinuxInputInjector] Error destroying kbDev:", err)
		}
		this.kbDev = null

		try {
			this.touchDev?.destroy()
		} catch (err) {
			console.error("[LinuxInputInjector] Error destroying touchDev:", err)
		}
		this.touchDev = null

		this.keyboard = null
		this.touch = null
		this.initialized = false
	}

	private initialize(): void {
		const mouseOk = this.setupMouseDevice()
		const kbOk = this.setupKeyboardDevice()
		const touchOk = this.setupTouchDevice()

		if (!mouseOk || !kbOk || !touchOk || !this.kbDev || !this.touchDev) {
			const msg =
				"One or more virtual uinput devices failed to initialize (check /dev/uinput permissions)"
			console.error(`[LinuxInputInjector] ${msg}`)
			this.destroy()
			this.initialized = false
			throw new Error(msg)
		}

		this.keyboard = new LinuxKeyboard(this.kbDev)
		this.touch = new LinuxTouch(this.touchDev)
		this.initialized = true
		console.log("[LinuxInputInjector] All virtual devices initialized")
	}

	private setupMouseDevice(): boolean {
		try {
			this.mouseDev = new UinputDevice({
				name: "Virtual Mouse",
				identity: DEVICE_IDENTITY,
			})
			this.mouseDev
				.setEventBit(EV_KEY)
				.setEventBit(EV_REL)
				.setEventBit(EV_SYN)
				.setKeyBit(BTN_LEFT)
				.setKeyBit(BTN_RIGHT)
				.setKeyBit(BTN_MIDDLE)
				.setRelativeBit(REL_X)
				.setRelativeBit(REL_Y)
				.setRelativeBit(REL_WHEEL)
				.setRelativeBit(REL_HWHEEL)
				.create()
			return true
		} catch (err) {
			console.error("[LinuxInputInjector] Failed to setup mouse device:", err)
			return false
		}
	}

	private setupKeyboardDevice(): boolean {
		try {
			this.kbDev = new UinputDevice({
				name: "Virtual Keyboard",
				identity: DEVICE_IDENTITY,
			})
			this.kbDev.setEventBit(EV_KEY).setEventBit(EV_SYN)

			for (const code of Object.values(LINUX_KEY_MAP)) {
				this.kbDev.setKeyBit(code)
			}

			this.kbDev.create()
			return true
		} catch (err) {
			console.error(
				"[LinuxInputInjector] Failed to setup keyboard device:",
				err,
			)
			return false
		}
	}

	private setupTouchDevice(): boolean {
		try {
			this.touchDev = new UinputDevice({
				name: "Virtual Touchpad",
				identity: DEVICE_IDENTITY,
			})
			this.touchDev
				.setEventBit(EV_ABS)
				.setEventBit(EV_KEY)
				.setEventBit(EV_SYN)
				.setKeyBit(BTN_TOUCH)
				.setKeyBit(BTN_TOOL_FINGER)
				.setKeyBit(BTN_TOOL_DOUBLETAP)
				.setKeyBit(BTN_TOOL_TRIPLETAP)
				.setKeyBit(BTN_TOOL_QUADTAP)
				.setAbsoluteBit(ABS_MT_SLOT)
				.setAbsoluteBit(ABS_MT_TRACKING_ID)
				.setAbsoluteBit(ABS_MT_POSITION_X)
				.setAbsoluteBit(ABS_MT_POSITION_Y)
				.setAbsoluteBit(ABS_MT_TOUCH_MAJOR)
				.setAbsoluteBit(ABS_MT_PRESSURE)
				.setAbsoluteBit(ABS_X)
				.setAbsoluteBit(ABS_Y)
				.configureAbsoluteAxis(ABS_MT_SLOT, {
					minimum: 0,
					maximum: MAX_CONTACTS - 1,
				})
				.configureAbsoluteAxis(ABS_MT_TRACKING_ID, {
					minimum: -1,
					maximum: 0x7fffffff,
				})
				.configureAbsoluteAxis(ABS_MT_POSITION_X, {
					minimum: 0,
					maximum: this.config.screenWidth,
				})
				.configureAbsoluteAxis(ABS_MT_POSITION_Y, {
					minimum: 0,
					maximum: this.config.screenHeight,
				})
				.configureAbsoluteAxis(ABS_MT_TOUCH_MAJOR, {
					minimum: 0,
					maximum: 255,
				})
				.configureAbsoluteAxis(ABS_MT_PRESSURE, {
					minimum: 0,
					maximum: 255,
				})
				.configureAbsoluteAxis(ABS_X, {
					minimum: 0,
					maximum: this.config.screenWidth,
				})
				.configureAbsoluteAxis(ABS_Y, {
					minimum: 0,
					maximum: this.config.screenHeight,
				})
				.create()
			return true
		} catch (err) {
			console.error("[LinuxInputInjector] Failed to setup touch device:", err)
			return false
		}
	}
}

export { LinuxKeyboard } from "./keyboard"
export { LinuxTouch } from "./touch"
