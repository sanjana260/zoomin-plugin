/**
 * Plugin settings. What the pywebview app asked at setup — the slot caps —
 * plus what the plugin can do that the app could not. The vault path is not
 * here: the plugin is in the vault.
 *
 * Settings live in `data.json` beside the store (one file, one `settings`
 * key), so they sync with the vault the way the store does.
 */

import { PluginSettingTab, Setting } from "obsidian";
import type ZoomInPlugin from "./main";

export interface ZoomInSettings {
  /** hard caps on the priority slots — a cap you can widen the moment it pinches is decoration, so they sit here, not on the panel */
  domainSlots: number;
  projectSlots: number;
  /** the sidebar's map — when the panel shows it — follows the note open in the editor */
  followActiveFile: boolean;
}

export const DEFAULT_SETTINGS: ZoomInSettings = {
  domainSlots: 3,
  projectSlots: 1,
  followActiveFile: true,
};

export class ZoomInSettingTab extends PluginSettingTab {
  constructor(
    app: ZoomInPlugin["app"],
    private readonly plugin: ZoomInPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const slot = (name: string, desc: string, key: "domainSlots" | "projectSlots") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (value) => {
              const n = Math.max(0, Math.min(12, Math.floor(Number(value))));
              if (!Number.isFinite(n)) return;
              this.plugin.settings[key] = n;
              await this.plugin.saveSettings();
            }),
        );

    slot("Domain slots", "How many domains can be priorities at once. A slot you fill costs you the others; that is the point.", "domainSlots");
    slot("Project slots", "How many projects can be priorities at once.", "projectSlots");

    new Setting(containerEl)
      .setName("Follow the note open in the editor")
      .setDesc("As you move between notes, the sidebar's map — when the panel is showing it — keeps the current note framed. Focusing a note deliberately still opens its dossier.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followActiveFile).onChange(async (value) => {
          this.plugin.settings.followActiveFile = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
