// Settings ▸ Claude (MCP): where a production run Claude asks for is
// confirmed. "kemudi" (default): Kemudi's run dialog (type the name, Run).
// "claude": Claude asks you in the chat and passes the name you typed.
import { create } from "zustand";

const KEY = "kemudi.mcp.prodConfirm";
export type ProdConfirm = "kemudi" | "claude";

function read(): ProdConfirm {
  try {
    return localStorage.getItem(KEY) === "claude" ? "claude" : "kemudi";
  } catch {
    return "kemudi";
  }
}

export const useMcpPrefs = create<{ prodConfirm: ProdConfirm; setProdConfirm(v: ProdConfirm): void }>((set) => ({
  prodConfirm: read(),
  setProdConfirm: (prodConfirm) => {
    try {
      localStorage.setItem(KEY, prodConfirm);
    } catch {
      // Not kept; fine.
    }
    set({ prodConfirm });
  },
}));
