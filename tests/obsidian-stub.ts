/**
 * The pieces of the `obsidian` module the pure code and the model touch,
 * stubbed for vitest. Views are never instantiated in tests.
 */

export class Plugin {}
export class ItemView {}
export class Modal {}
export class SuggestModal<T> {}
export class Notice {
  constructor(public message: string) {}
}
export class WorkspaceLeaf {}
export class TFile {
  constructor(public path: string) {}
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
