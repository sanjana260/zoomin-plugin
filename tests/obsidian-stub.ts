/**
 * The pieces of the `obsidian` module the pure code and the model touch,
 * stubbed for vitest. Views are never instantiated in tests.
 */

export class Component {
  registerDomEvent(): unknown {
    return {};
  }
  registerEvent(): unknown {
    return {};
  }
}

export class Plugin {}
export class ItemView extends Component {
  contentEl: HTMLElement = document.createElement("div");
  navigation = true;
}
export class Modal {
  modalEl: HTMLElement = document.createElement("div");
  contentEl: HTMLElement = document.createElement("div");
  open(): void {}
  close(): void {}
}
export class SuggestModal<T> {
  items: T[] = [];
}
export class Notice {
  constructor(public message: string) {}
}
export class WorkspaceLeaf {}
export class TFile {
  constructor(public path: string) {}
}
export class TAbstractFile {}

export function setIcon(): void {}

export function debounce<T extends unknown[]>(fn: (...args: T) => unknown): (...args: T) => void {
  return (...args: T) => {
    fn(...args);
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** Obsidian's `parseLinktext`: split `Note#Heading` into path and subpath. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const hash = linktext.indexOf("#");
  if (hash < 0) return { path: linktext, subpath: "" };
  return { path: linktext.slice(0, hash), subpath: linktext.slice(hash) };
}
