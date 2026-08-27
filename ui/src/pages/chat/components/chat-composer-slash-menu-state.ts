import type { SlashMenuState } from "./chat-composer-slash-menu.ts";

export function createSlashMenuState(): SlashMenuState {
  return {
    slashCommandDispatchConnected: false,
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuCompletion: null,
    slashCommandRefreshPending: false,
  };
}
