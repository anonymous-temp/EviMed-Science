import type { GeoProject, GeoStepKey } from "@/lib/geoClient";
import type { WorkNeedKind } from "@/lib/workState";
import { GEO_STEP_NAMES } from "./geoText";

/** What the project asks of its person, as the bar over every view says it; the 总览's 「需要你」 is where each one is done. */
export function geoNeeds(project: Pick<GeoProject, "needsYou">, can: (ability: string) => boolean): Array<{ key: string; kind: WorkNeedKind; text: string }> {
  type Need = { key: string; kind: WorkNeedKind; text: string };
  return (project.needsYou ?? []).flatMap((item): Need[] => {
    const step = item.object.type === "step" && item.object.id ? GEO_STEP_NAMES[item.object.id as GeoStepKey] : null;
    switch (item.kind) {
      // Only the person who may set it is asked: a reader told 「等你」 about money they cannot move has nothing to do with it.
      case "set_budget": return can("manage_money") ? [{ key: item.key, kind: "confirm", text: "设置投放预算" }] : [];
      case "release_articles": return can("review") ? [{ key: item.key, kind: "confirm", text: `放行 ${item.count ?? item.object.ids?.length ?? 0} 篇稿件` }] : [];
      case "correct_severe_error": return can("edit") ? [{ key: item.key, kind: "resolve", text: "有严重讲错待纠正" }] : [];
      case "client_action": return [{ key: item.key, kind: "offline", text: item.text ?? "有一件事需要在平台外完成" }];
      case "credits_waiting": return step && can("run") ? [{ key: item.key, kind: "resolve", text: `${step}等你补额度` }] : [];
      case "step_failed": return step && can("run") ? [{ key: item.key, kind: "resolve", text: `${step}未完成，已算出的部分保留` }] : [];
      default: return [];
    }
  });
}
