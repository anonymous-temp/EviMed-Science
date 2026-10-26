export interface QuantityPolicy {
  scale: "scalar" | "percent" | "fraction";
  unit: string;
  min?: number;
  max?: number;
  gt?: number;
  lt?: number;
  integer?: boolean;
  exponent?: boolean;
  precision?: number;
}
export type ParsedQuantity = { ok: true; value: number } | { ok: false; error: string };

/** Parse displayed input once; bounds always apply to the canonical value. */
export function parseQuantity(raw: string, policy: QuantityPolicy): ParsedQuantity {
  if (!raw.trim()) return { ok: false, error: "请输入数值" };
  const grammar = policy.exponent ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!grammar.test(raw.trim())) return { ok: false, error: "请输入完整数值" };
  const entered = Number(raw);
  const value = policy.scale === "percent" ? entered / 100 : entered;
  if (!Number.isFinite(value)) return { ok: false, error: "请输入有限数值" };
  if (policy.integer && !Number.isInteger(value)) return { ok: false, error: "请输入整数" };
  if (policy.precision !== undefined && (raw.split(/[eE]/)[0].split(".")[1]?.length ?? 0) > policy.precision) return { ok: false, error: `最多输入 ${policy.precision} 位小数` };
  if ((policy.min !== undefined && value < policy.min) || (policy.max !== undefined && value > policy.max) || (policy.gt !== undefined && value <= policy.gt) || (policy.lt !== undefined && value >= policy.lt)) return { ok: false, error: "数值超出允许范围" };
  return { ok: true, value };
}

/** Reuse for editing and confirmation; saved values always remain canonical. */
export function formatQuantity(value: number, policy: QuantityPolicy): string {
  return String(policy.scale === "percent" ? value * 100 : value);
}
