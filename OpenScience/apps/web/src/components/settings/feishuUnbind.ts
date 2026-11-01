/**
 * What unbinding the Feishu bot asks first: one confirmation, said once, for the two places that can do it (the 通知 settings and the
 * inbox notice that announces a new binding). The inbox's 解除绑定 used to unbind in one click while the settings page confirmed
 * (2026-11-01 audit D4).
 */
export const FEISHU_UNBIND_ACTION = "feishu-unbind";
export const FEISHU_UNBIND_CONFIRM = {
  title: "解除飞书机器人的绑定？",
  body: "解除后，飞书里的消息不再派发任务，通知也不再推送到飞书；已经完成的任务不受影响。机器人应用仍在你的飞书里，不再需要时可以在飞书开发者后台删除。",
  confirmLabel: "解除绑定",
} as const;
