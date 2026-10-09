// Tab colours (right-click a tab), Warp-style. Dracula hues on the dark
// active tab; their light "Alucard" counterparts on the light tab strip.
// `light` is only a 3 px bar and a faint tint (and the swatch), never text,
// so it can be as bright as the colour really is.
export const TAB_COLORS = {
  red: { label: "Red", dark: "#ff5555", light: "#cb3a2a" },
  crimson: { label: "Crimson", dark: "#ff5c7a", light: "#e11d48" },
  maroon: { label: "Maroon", dark: "#d98080", light: "#881337" },
  coral: { label: "Coral", dark: "#ff8e72", light: "#f26b4f" },
  orange: { label: "Orange", dark: "#ffb86c", light: "#ea580c" },
  amber: { label: "Amber", dark: "#ffc857", light: "#f59e0b" },
  gold: { label: "Gold", dark: "#ffd75e", light: "#ca8a04" },
  yellow: { label: "Yellow", dark: "#f1fa8c", light: "#facc15" },
  brown: { label: "Brown", dark: "#d4a373", light: "#7a4b1e" },
  lime: { label: "Lime", dark: "#c3f73a", light: "#4d7c0f" },
  green: { label: "Green", dark: "#50fa7b", light: "#14710a" },
  teal: { label: "Teal", dark: "#5eead4", light: "#0f766e" },
  cyan: { label: "Cyan", dark: "#8be9fd", light: "#036a96" },
  blue: { label: "Blue", dark: "#6ea8fe", light: "#1d4ed8" },
  indigo: { label: "Indigo", dark: "#a5b4fc", light: "#4338ca" },
  purple: { label: "Purple", dark: "#bd93f9", light: "#644ac9" },
  pink: { label: "Pink", dark: "#ff79c6", light: "#a3144d" },
  gray: { label: "Gray", dark: "#c0c4d6", light: "#5b6170" },
} as const;

export type TabColor = keyof typeof TAB_COLORS;

export const isTabColor = (v: unknown): v is TabColor => typeof v === "string" && v in TAB_COLORS;
