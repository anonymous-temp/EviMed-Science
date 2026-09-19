/**
 * The registry: the one place the control plane asks which channels exist,
 * which are switched on, and what each one's adapter is.
 *
 * Nothing else imports an adapter. The inbox validates preferences here, the
 * IM service resolves adapters here, and the settings page lists channels from
 * here — so a channel added later is a row in `createChannelRegistry` and a
 * key in `config.mjs`, and a channel switched off disappears from all three at
 * once instead of from whichever one somebody remembered.
 *
 * Every channel is off unless the IM module is on (`OPEN_SCIENCE_IM_ENABLED`):
 * with it off the inbox validates exactly what it did before this existed
 * (`["in-app"]`), which is what "individually switchable, native stays the
 * control" (principle 11) asks of a new module.
 *
 * @module channels/registry
 */

import { HttpError } from "../security.mjs";
import { CHANNEL_IDS, CHANNEL_TITLES, IN_APP_CHANNEL, assertChannelAdapter } from "./port.mjs";

export class ChannelRegistry {
  /**
   * @param {{ adapters: readonly any[], enabled: (id: string) => boolean }} input
   */
  constructor({ adapters, enabled }) {
    /** @type {Map<string, any>} */
    this.adapters = new Map();
    for (const adapter of adapters) {
      assertChannelAdapter(adapter);
      if (this.adapters.has(adapter.id)) throw new TypeError(`Channel ${adapter.id} is registered twice.`);
      this.adapters.set(adapter.id, adapter);
    }
    this.enabled = enabled;
  }

  /** @param {string} id */
  get(id) {
    return this.adapters.get(id) ?? null;
  }

  /** @param {string} id */
  isEnabled(id) {
    return this.adapters.has(id) && this.enabled(id) === true;
  }

  /** The channels a preference may name besides the inbox. */
  enabledIds() {
    return CHANNEL_IDS.filter((id) => this.isEnabled(id));
  }

  /**
   * A preference's channel list, checked: the inbox always, first, plus any
   * enabled channel, each at most once. The inbox is the record, so a list
   * without it is refused rather than read as "push only".
   * @param {unknown} value
   * @returns {string[]}
   */
  preferenceChannels(value) {
    const enabled = this.enabledIds();
    if (!Array.isArray(value) || value.length < 1 || value.length > enabled.length + 1
      || value[0] !== IN_APP_CHANNEL || new Set(value).size !== value.length
      || value.slice(1).some((id) => typeof id !== "string" || !enabled.includes(id))) {
      const allowed = [IN_APP_CHANNEL, ...enabled].join(", ");
      throw new HttpError(400, "notification_preferences_invalid",
        `Notification channels must start with in-app and may add only enabled channels (${allowed}).`);
    }
    return [...value];
  }

  /** What the settings page lists: every known channel and where it stands. */
  describe() {
    return CHANNEL_IDS.map((id) => {
      const adapter = this.adapters.get(id);
      const enabled = this.isEnabled(id);
      const status = enabled && adapter ? adapter.status() : { state: "disabled", reason: null };
      return {
        id,
        title: CHANNEL_TITLES[/** @type {keyof typeof CHANNEL_TITLES} */ (id)],
        enabled,
        reserved: adapter?.reserved === true,
        state: status.state,
        reason: status.reason ?? null,
      };
    });
  }
}

/**
 * The switch each channel answers to, from config.
 * @param {Record<string, any>} config
 * @returns {(id: string) => boolean}
 */
export function channelSwitches(config) {
  return (id) => {
    if (config?.imEnabled !== true) return false;
    if (id === "feishu") return true;
    return config?.channelEnabled?.[id] === true;
  };
}
