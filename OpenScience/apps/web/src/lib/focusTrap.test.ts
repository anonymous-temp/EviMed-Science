import { describe, expect, it } from "vitest";
import { focusableIn, isFocusLayer, isTopFocusLayer, ownsKeyboard, registerFocusLayer, trapTab } from "./focusTrap";

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
 it("puts a layer registered inside another above it, and a later one above both",()=>{
  const outer=document.createElement("div"),inner=document.createElement("div"),later=document.createElement("div");outer.append(inner);document.body.append(outer,later);
  const removeInner=registerFocusLayer(inner),removeOuter=registerFocusLayer(outer);
  expect(isTopFocusLayer(inner)).toBe(true);expect(isFocusLayer(outer)).toBe(true);
  const removeLater=registerFocusLayer(later);expect(isTopFocusLayer(later)).toBe(true);expect(isTopFocusLayer(inner)).toBe(false);
  removeLater();expect(isTopFocusLayer(inner)).toBe(true);
  removeOuter();removeInner();expect(isFocusLayer(inner)).toBe(false);outer.remove();later.remove();
 });
 it("lets a modal that never registered keep the keys typed inside it",()=>{
  const panel=document.createElement("div"),stray=document.createElement("div"),button=document.createElement("button");
  stray.setAttribute("aria-modal","true");stray.append(button);panel.append(stray);document.body.append(panel);
  const remove=registerFocusLayer(panel);
  const typed=(target:Element)=>{const event=new KeyboardEvent("keydown",{key:"Escape",bubbles:true});target.dispatchEvent(event);return event;};
  let owns=true;const listen=(event:Event)=>{owns=ownsKeyboard(panel,event);};document.addEventListener("keydown",listen);
  typed(button);expect(owns).toBe(false);
  typed(panel);expect(owns).toBe(true);
  document.removeEventListener("keydown",listen);remove();panel.remove();
 });
});
