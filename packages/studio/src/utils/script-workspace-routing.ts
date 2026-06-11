export const SCRIPT_WORKSPACE_FLAG_KEY = "studio.book-detail.open-script-workspace";

type ScriptWorkspaceFlagReader = Pick<Storage, "getItem" | "removeItem">;
type ScriptWorkspaceFlagWriter = Pick<Storage, "setItem">;

export function markScriptWorkspaceAutoOpen(storage?: ScriptWorkspaceFlagWriter | null): void {
  storage?.setItem(SCRIPT_WORKSPACE_FLAG_KEY, "1");
}

export function consumeScriptWorkspaceAutoOpenFlag(storage: ScriptWorkspaceFlagReader | null | undefined, ready: boolean): boolean {
  if (!ready || !storage) return false;
  if (storage.getItem(SCRIPT_WORKSPACE_FLAG_KEY) !== "1") return false;
  storage.removeItem(SCRIPT_WORKSPACE_FLAG_KEY);
  return true;
}
