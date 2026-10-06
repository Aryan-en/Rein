import { describe, it, expect, beforeEach } from "vitest"
import type { UinputDevice } from "@imxade/inject/linux"
import { LinuxKeyboard } from "../src/linux/keyboard"
import { LinuxTouch } from "../src/linux/touch"
import {
	EV_KEY,
	EV_ABS,
	KEY_PRESS,
	KEY_RELEASE,
	ABS_MT_SLOT,
	ABS_MT_TRACKING_ID,
	ABS_MT_POSITION_X,
	ABS_MT_POSITION_Y,
	ABS_MT_PRESSURE,
	ABS_MT_TOUCH_MAJOR,
	BTN_TOUCH,
	BTN_TOOL_FINGER,
	BTN_TOOL_DOUBLETAP,
	BTN_TOOL_TRIPLETAP,
	BTN_TOOL_QUADTAP,
	MT_TRACKING_ID_RELEASED,
} from "../src/linux/constants"
import { LINUX_KEY_MAP } from "../src/keyMap"

interface RecordedEvent {
	type: number
	code: number
	value: number
}

class MockUinputDevice {
	events: RecordedEvent[] = []
	syncCount = 0

	emit(type: number, code: number, value: number): this {
		this.events.push({ type, code, value })
		return this
	}

	sync(): this {
		this.syncCount++
		return this
	}

	clear(): void {
		this.events = []
		this.syncCount = 0
	}
}

describe("LinuxKeyboard Driver Unit Tests (Mocked UinputDevice)", () => {
	let mockDevice: MockUinputDevice
	let keyboard: LinuxKeyboard

	beforeEach(() => {
		mockDevice = new MockUinputDevice()
		keyboard = new LinuxKeyboard(mockDevice as unknown as UinputDevice)
	})

	it("injects a normal key with press, release, and sync", () => {
		keyboard.injectKey("a", "")

		expect(mockDevice.events).toEqual([
			{ type: EV_KEY, code: LINUX_KEY_MAP.a, value: KEY_PRESS },
			{ type: EV_KEY, code: LINUX_KEY_MAP.a, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("handles HOLD position without releasing the key", () => {
		keyboard.injectKey("shift", "HOLD")

		expect(mockDevice.events).toEqual([
			{ type: EV_KEY, code: LINUX_KEY_MAP.shift, value: KEY_PRESS },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("handles RELEASE position without pressing the key", () => {
		keyboard.injectKey("shift", "RELEASE")

		expect(mockDevice.events).toEqual([
			{ type: EV_KEY, code: LINUX_KEY_MAP.shift, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("injects key combos in order and releases in reverse order", () => {
		keyboard.injectCombo(["control", "alt", "t"])

		const ctrl = LINUX_KEY_MAP.control
		const alt = LINUX_KEY_MAP.alt
		const t = LINUX_KEY_MAP.t

		expect(mockDevice.events).toEqual([
			// Presses in order
			{ type: EV_KEY, code: ctrl, value: KEY_PRESS },
			{ type: EV_KEY, code: alt, value: KEY_PRESS },
			{ type: EV_KEY, code: t, value: KEY_PRESS },
			// Releases in reverse order
			{ type: EV_KEY, code: t, value: KEY_RELEASE },
			{ type: EV_KEY, code: alt, value: KEY_RELEASE },
			{ type: EV_KEY, code: ctrl, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(2)
	})

	it("injects shifted text characters with shift modifier wrapper", () => {
		keyboard.injectText("!")

		const shift = LINUX_KEY_MAP.shift
		const one = LINUX_KEY_MAP["1"]

		expect(mockDevice.events).toEqual([
			{ type: EV_KEY, code: shift, value: KEY_PRESS },
			{ type: EV_KEY, code: one, value: KEY_PRESS },
			{ type: EV_KEY, code: one, value: KEY_RELEASE },
			{ type: EV_KEY, code: shift, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("handles single-character fallback in injectKey for symbols not in keymap", () => {
		keyboard.injectKey("!", "")

		const shift = LINUX_KEY_MAP.shift
		const one = LINUX_KEY_MAP["1"]

		expect(mockDevice.events).toEqual([
			{ type: EV_KEY, code: shift, value: KEY_PRESS },
			{ type: EV_KEY, code: one, value: KEY_PRESS },
			{ type: EV_KEY, code: one, value: KEY_RELEASE },
			{ type: EV_KEY, code: shift, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("ignores empty text without emitting events", () => {
		keyboard.injectText("")
		expect(mockDevice.events).toHaveLength(0)
		expect(mockDevice.syncCount).toBe(0)
	})
})

describe("LinuxTouch Driver Unit Tests (Mocked UinputDevice)", () => {
	let mockDevice: MockUinputDevice
	let touch: LinuxTouch

	beforeEach(() => {
		mockDevice = new MockUinputDevice()
		touch = new LinuxTouch(mockDevice as unknown as UinputDevice)
	})

	it("handles single contact down, move, and up lifecycle", () => {
		// Contact Down
		touch.injectTouch([{ id: 101, x: 120, y: 240, state: "down" }])

		expect(mockDevice.events).toEqual([
			{ type: EV_ABS, code: ABS_MT_SLOT, value: 0 },
			{ type: EV_ABS, code: ABS_MT_TRACKING_ID, value: 2 },
			{ type: EV_ABS, code: ABS_MT_POSITION_X, value: 120 },
			{ type: EV_ABS, code: ABS_MT_POSITION_Y, value: 240 },
			{ type: EV_ABS, code: ABS_MT_PRESSURE, value: 128 },
			{ type: EV_ABS, code: ABS_MT_TOUCH_MAJOR, value: 4 },
			{ type: EV_KEY, code: BTN_TOUCH, value: KEY_PRESS },
			{ type: EV_KEY, code: BTN_TOOL_FINGER, value: KEY_PRESS },
			{ type: EV_KEY, code: BTN_TOOL_DOUBLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_TRIPLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_QUADTAP, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)

		mockDevice.clear()

		// Contact Move
		touch.injectTouch([{ id: 101, x: 130, y: 250, state: "move" }])
		expect(mockDevice.events).toEqual([
			{ type: EV_ABS, code: ABS_MT_SLOT, value: 0 },
			{ type: EV_ABS, code: ABS_MT_POSITION_X, value: 130 },
			{ type: EV_ABS, code: ABS_MT_POSITION_Y, value: 250 },
			{ type: EV_ABS, code: ABS_MT_PRESSURE, value: 128 },
			{ type: EV_ABS, code: ABS_MT_TOUCH_MAJOR, value: 4 },
			{ type: EV_KEY, code: BTN_TOUCH, value: KEY_PRESS },
			{ type: EV_KEY, code: BTN_TOOL_FINGER, value: KEY_PRESS },
			{ type: EV_KEY, code: BTN_TOOL_DOUBLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_TRIPLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_QUADTAP, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)

		mockDevice.clear()

		// Contact Up
		touch.injectTouch([{ id: 101, x: 130, y: 250, state: "up" }])
		expect(mockDevice.events).toEqual([
			// Lift contact (slot 9, initial free slot pop from reverse array)
			{ type: EV_ABS, code: ABS_MT_SLOT, value: 0 },
			{
				type: EV_ABS,
				code: ABS_MT_TRACKING_ID,
				value: MT_TRACKING_ID_RELEASED,
			},
			// Active contacts = 0 => release all tool buttons
			{ type: EV_KEY, code: BTN_TOUCH, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_FINGER, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_DOUBLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_TRIPLETAP, value: KEY_RELEASE },
			{ type: EV_KEY, code: BTN_TOOL_QUADTAP, value: KEY_RELEASE },
		])
		expect(mockDevice.syncCount).toBe(1)
	})

	it("allocates discrete slots and updates tool buttons for multitouch contacts", () => {
		// Down with 2 fingers
		touch.injectTouch([
			{ id: 1, x: 100, y: 100, state: "down" },
			{ id: 2, x: 200, y: 200, state: "down" },
		])

		const events = mockDevice.events
		const btnDoubleTap = events.find((e) => e.code === BTN_TOOL_DOUBLETAP)
		const btnFinger = events.find((e) => e.code === BTN_TOOL_FINGER)

		expect(btnDoubleTap).toEqual({
			type: EV_KEY,
			code: BTN_TOOL_DOUBLETAP,
			value: KEY_PRESS,
		})
		expect(btnFinger).toEqual({
			type: EV_KEY,
			code: BTN_TOOL_FINGER,
			value: KEY_RELEASE,
		})

		mockDevice.clear()

		// Add 3rd finger
		touch.injectTouch([{ id: 3, x: 300, y: 300, state: "down" }])
		const tripleEvents = mockDevice.events
		const btnTripleTap = tripleEvents.find((e) => e.code === BTN_TOOL_TRIPLETAP)
		expect(btnTripleTap).toEqual({
			type: EV_KEY,
			code: BTN_TOOL_TRIPLETAP,
			value: KEY_PRESS,
		})
	})

	it("releaseAll releases all active contacts and resets slots", () => {
		touch.injectTouch([
			{ id: 1, x: 10, y: 10, state: "down" },
			{ id: 2, x: 20, y: 20, state: "down" },
		])
		mockDevice.clear()

		touch.releaseAll()

		const releaseTrackingEvents = mockDevice.events.filter(
			(e) =>
				e.type === EV_ABS &&
				e.code === ABS_MT_TRACKING_ID &&
				e.value === MT_TRACKING_ID_RELEASED,
		)
		expect(releaseTrackingEvents).toHaveLength(2)

		const btnTouchRelease = mockDevice.events.find(
			(e) =>
				e.type === EV_KEY && e.code === BTN_TOUCH && e.value === KEY_RELEASE,
		)
		expect(btnTouchRelease).toBeDefined()
		expect(mockDevice.syncCount).toBe(1)

		// Calling releaseAll again when empty is a no-op
		mockDevice.clear()
		touch.releaseAll()
		expect(mockDevice.events).toHaveLength(0)
		expect(mockDevice.syncCount).toBe(0)
	})
})
