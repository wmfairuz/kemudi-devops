// Environment + status vocab shared by every component (design frame 1j).
export type Env = "prod" | "staging" | "qa" | "dev";
export type Status = "up" | "down" | "checking" | "unknown";

export const envLabel: Record<Env, string> = { prod: "PROD", staging: "STG", qa: "QA", dev: "DEV" };

/** Inset 2px left bar on server groups / history rows. */
export const envBar: Record<Env, string> = {
  prod: "shadow-[inset_2px_0_0_var(--env-prod)]",
  staging: "shadow-[inset_2px_0_0_var(--env-staging)]",
  qa: "shadow-[inset_2px_0_0_var(--env-qa)]",
  dev: "",
};
