import { readFileSync } from "node:fs";

const modes = new Set(["lite", "full", "ultra", "off"]);
const stateKey = "local.ponytail.mode";
const skill = readFileSync(new URL("../skills/ponytail/SKILL.md", import.meta.url), "utf8")
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

export default function ponytail(pi) {
  let mode = "full";
  const show = (ctx) => {
    const { cost } = ctx.sessionManager.getUsageStatistics();
    ctx.ui.setStatus("00-cost", ctx.ui.theme.fg("statusLineCost", `$${cost.toFixed(2)}`));
    ctx.ui.setStatus("ponytail", `pt: ${mode}`);
  };
  const restore = (_event, ctx) => {
    mode = "full";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === stateKey && modes.has(entry.data?.mode)) {
        mode = entry.data.mode;
      }
    }
    show(ctx);
  };
  const select = (next, ctx) => {
    mode = next;
    pi.appendEntry(stateKey, { mode });
    show(ctx);
  };

  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
    pi.on(event, restore);
  }
  for (const event of ["message_end", "agent_end"]) {
    pi.on(event, (_event, ctx) => show(ctx));
  }
  pi.registerCommand("ponytail", {
    description: "Set Ponytail mode: lite, full, ultra, off; or show status",
    handler: async (args, ctx) => {
      const next = args.trim().toLowerCase();
      if (!next || next === "status") {
        ctx.ui.notify(`pt: ${mode}`, "info");
      } else if (modes.has(next)) {
        select(next, ctx);
      } else {
        ctx.ui.notify("Use /ponytail lite|full|ultra|off|status", "warning");
      }
    },
  });
  pi.on("input", (event, ctx) => {
    if (/^(?:stop ponytail|normal mode)[.!]?$/i.test(event.text.trim())) select("off", ctx);
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${mode === "off"
      ? "Ponytail is OFF. Do not activate its skill or apply earlier Ponytail mode instructions unless the user explicitly asks to re-enable it."
      : `${skill}\n\nPonytail controller: the selected intensity is ${mode}. This overrides the skill's default and earlier mode selections. Keep this intensity until the user changes it with /ponytail. Apply Ponytail only to coding tasks; preserve all explicit requirements and higher-priority instructions.`}`,
  }));
}
