import { describe, expect, it } from "vitest";
import { focusableIn, registerFocusLayer, trapTab } from "./focusTrap";

describe("modal tabbability", () => {
 it("excludes negative indices, hidden inputs, inert and disabled fieldsets except their first legend", () => {
  const panel=document.createElement("div");document.body.append(panel);
  panel.innerHTML='<button tabindex="-2">negative</button><input type="hidden"><div inert><button>inert</button></div><fieldset disabled><legend><button>legend</button></legend><button>disabled</button></fieldset><input type="radio" name="r"><input type="radio" name="r" checked><button>last</button>';
  expect(focusableIn(panel).map(e=>e.textContent || e.tagName)).toEqual(["legend","INPUT","last"]);
  panel.remove();
 });
 it("focuses an empty panel and leaves lower layers alone",()=>{
  const outer=document.createElement("div"),inner=document.createElement("div");outer.tabIndex=inner.tabIndex=-1;document.body.append(outer,inner);
  const removeOuter=registerFocusLayer(outer),removeInner=registerFocusLayer(inner);
  const event=new KeyboardEvent("keydown",{key:"Tab",cancelable:true});trapTab(outer,event);expect(event.defaultPrevented).toBe(false);
  trapTab(inner,event);expect(inner).toHaveFocus();expect(event.defaultPrevented).toBe(true);
  removeInner();removeOuter();outer.remove();inner.remove();
 });
});
