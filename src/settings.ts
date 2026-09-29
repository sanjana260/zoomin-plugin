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
import { DatatypesModal } from "./views/datatypes-modal";

export interface ZoomInSettings {
  /** hard caps on the priority slots — a cap you can widen the moment it pinches is decoration, so they sit here, not on the panel */
  domainSlots: number;
  projectSlots: number;
  /** the deadline feed's red tier: overdue plus this many days out */
  urgentDays: number;
  /** the yellow tier: past the urgent window but within this many days */
  dueSoonDays: number;
  /** the sidebar's map — when the panel shows it — follows the note open in the editor */
  followActiveFile: boolean;
}

export const DEFAULT_SETTINGS: ZoomInSettings = {
  domainSlots: 3,
  projectSlots: 1,
  urgentDays: 1,
  dueSoonDays: 7,
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

    const days = (name: string, desc: string, key: "urgentDays" | "dueSoonDays") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setValue(String(this.plugin.settings[key]))
            .onChange(async (value) => {
              const n = Math.max(0, Math.min(365, Math.floor(Number(value))));
              if (!Number.isFinite(n)) return;
              this.plugin.settings[key] = n;
              await this.plugin.saveSettings();
            }),
        );

    days("Urgent within (days)", "Deadlines with less than this many days left are urgent — the feed's red tier. One day by default: today only; tomorrow counts as due soon. Overdue is always urgent.", "urgentDays");
    days("Due soon within (days)", "Past the urgent window, deadlines with less than this many days left are due soon — the feed's yellow tier. Seven by default: tomorrow through six days out.", "dueSoonDays");

    // The panel's head now says "Settings"; the datatypes dialog keeps its own
    // way in, here and as a command.
    new Setting(containerEl)
      .setName("Datatypes")
      .setDesc("Give a category a shape on the map, or flag it as a kind of project.")
      .addButton((button) =>
        button.setButtonText("Edit datatypes").onClick(() => {
          new DatatypesModal(this.app, this.plugin).open();
        }),
      );

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
