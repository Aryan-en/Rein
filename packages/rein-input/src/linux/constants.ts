// Re-export core event families and sync constant from @imxade/inject/linux
export {
	EV_SYN,
	EV_KEY,
	EV_REL,
	EV_ABS,
	SYN_REPORT,
} from "@imxade/inject/linux"

// ---- Relative axes (mouse movement / scroll) ----
export const REL_X = 0x00
export const REL_Y = 0x01
export const REL_WHEEL = 0x08
export const REL_HWHEEL = 0x06

// ---- Absolute axes (multitouch) ----
export const ABS_X = 0x00
export const ABS_Y = 0x01
export const ABS_MT_SLOT = 0x2f
export const ABS_MT_TRACKING_ID = 0x39
export const ABS_MT_POSITION_X = 0x35
export const ABS_MT_POSITION_Y = 0x36
export const ABS_MT_TOUCH_MAJOR = 0x30
export const ABS_MT_PRESSURE = 0x3a

// ---- Mouse buttons ----
export const BTN_LEFT = 0x110
export const BTN_RIGHT = 0x111
export const BTN_MIDDLE = 0x112

// ---- Touchpad / touch tool buttons ----
export const BTN_TOUCH = 0x14a
export const BTN_TOOL_FINGER = 0x145
export const BTN_TOOL_DOUBLETAP = 0x14d
export const BTN_TOOL_TRIPLETAP = 0x14e
export const BTN_TOOL_QUADTAP = 0x14f

// ---- Key press states ----
export const KEY_PRESS = 1
export const KEY_RELEASE = 0
export const KEY_REPEAT = 2

// ---- Misc ----
export const MAX_CONTACTS = 10
export const MT_TRACKING_ID_RELEASED = -1
