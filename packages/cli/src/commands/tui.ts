import { Command } from "commander";

export interface TuiCommandHooks {
  readonly launchTui?: (projectRoot: string) => Promise<void> | void;
}

export function createTuiCommand(hooks: TuiCommandHooks = {}): Command {
  return new Command("tui")
    .description("Open the InkOS project workspace TUI")
    .action(async () => {
      if (hooks.launchTui) {
        await hooks.launchTui(process.cwd());
        return;
      }
      const { launchTui } = await import("../tui/app.js");
      await launchTui(process.cwd());
    });
}
