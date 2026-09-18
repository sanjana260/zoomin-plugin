/**
 * Obsidian's HTMLElement extensions — createEl/createDiv/empty/toggle/… —
 * polyfilled for jsdom, so the real views can be mounted and clicked in
 * tests. Only what the views use; a missing method fails loudly, which is
 * the point.
 */

import { afterEach } from "vitest";

type Options = { cls?: string; text?: string; attr?: Record<string, string> };

function apply(el: HTMLElement, o?: Options): HTMLElement {
  if (o?.cls) el.className = o.cls;
  if (o?.text !== undefined) el.textContent = o.text;
  if (o?.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  return el;
}

if (typeof HTMLElement !== "undefined" && !(HTMLElement.prototype as never as { __zoominDom: boolean }).__zoominDom) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.__zoominDom = true;
  proto.createEl = function (this: HTMLElement, tag: string, o?: Options) {
    // Obsidian's createEl appends; so must this, or nothing mounts.
    const el = apply(this.ownerDocument!.createElement(tag), o);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, o?: Options) {
    return (this as unknown as { createEl(tag: string, o?: Options): HTMLElement }).createEl("div", o);
  };
  proto.createSpan = function (this: HTMLElement, o?: Options) {
    return (this as unknown as { createEl(tag: string, o?: Options): HTMLElement }).createEl("span", o);
  };
  proto.appendText = function (this: HTMLElement, text: string) {
    this.appendChild(document.createTextNode(text));
    return this;
  };
  proto.empty = function (this: HTMLElement) {
    this.textContent = "";
    return this;
  };
  proto.setText = function (this: HTMLElement, text: string) {
    this.textContent = text;
    return this;
  };
  proto.toggle = function (this: HTMLElement, show?: boolean, display?: string) {
    this.style.display = (show ?? !this.isShown()) ? (display ?? "") : "none";
    return this;
  };
  proto.isShown = function (this: HTMLElement): boolean {
    let el: HTMLElement | null = this;
    while (el) {
      if (getComputedStyle(el).display === "none") return false;
      el = el.parentElement;
    }
    return true;
  };
  proto.show = function (this: HTMLElement, display?: string) {
    this.style.display = display ?? "";
    return this;
  };
  proto.hide = function (this: HTMLElement) {
    this.style.display = "none";
    return this;
  };
  proto.addClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.add(...classes);
    return this;
  };
  proto.removeClass = function (this: HTMLElement, ...classes: string[]) {
    this.classList.remove(...classes);
    return this;
  };
}

afterEach(() => {
  document.body.textContent = "";
});
