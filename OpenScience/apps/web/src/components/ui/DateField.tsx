import { Input, type InputProps } from "./Input";
/**
 * Component: DateField; owner: H; rules: DS21, AT48/49.
 * Anatomy: calendar date only, preserved as YYYY-MM-DD without instant conversion.
 * Variants: native controls with explicit labels.
 * States: controlled value, disabled, error and help.
 * Hit area: shared input control geometry and native calendar affordance.
 * Keyboard: native traversal and activation; composition is preserved.
 * Long content: labels and feedback wrap; native calendar rendering is browser-owned.
 * Theme: semantic surface, control border, text and error roles.
 * Responsive: full available width; no fixed viewport dimensions.
 * Verification: InputPrimitives.test.tsx; InputPrimitivesGallery; manual AT review pending.
 */
export function DateField(props: Omit<InputProps, "type">) { return <Input {...props} type="date" />; }
/**
 * Component: DateRange; owner: H; rules: DS21, AT48/49.
 * Anatomy: fieldset with two calendar dates; inclusive endpoints; optional open ends.
 * Variants: native controls with explicit labels.
 * States: controlled strings; reversed order is invalid; allowOpen=false requires both ends when either is set.
 * Hit area: shared input geometry and native calendar affordance.
 * Keyboard: native calendar-date editing and focus traversal.
 * Long content: legends and feedback wrap; native calendar is browser-owned.
 * Theme: shared Input surface, border and error roles.
 * Responsive: two columns at all widths; narrow native-field fit needs browser verification.
 * Verification: InputPrimitives.test.tsx; InputPrimitivesGallery; manual AT review pending.
 */
export function DateRange({ label, start, end, onChange, allowOpen = true }: { label: string; start: string; end: string; onChange(start: string, end: string): void; allowOpen?: boolean }) {
 const error = start && end && start > end ? "开始日期不能晚于结束日期。" : !allowOpen && Boolean(start) !== Boolean(end) ? `请填写完整的${label}区间。` : undefined;
 return <fieldset><legend className="text-ui">{label}（含首尾日期）</legend><div className="grid grid-cols-2 gap-3"><DateField label={`${label}开始日期`} value={start} onChange={e => onChange(e.target.value, end)} error={error} /><DateField label={`${label}结束日期`} value={end} onChange={e => onChange(start, e.target.value)} /></div>{allowOpen && <p className="text-ui text-text-2">留空表示不限该端日期。</p>}</fieldset>;
}
