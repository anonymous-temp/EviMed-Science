import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { TabFrame, makeFrameSpies } from "./__fixtures__/tabFrame";
import { VcrVersionComparison } from "./VcrVersionComparison";
it("requires two explicit versions and binds their immutable selection outside visible prose", async () => {
  const spies = makeFrameSpies();
  render(<MemoryRouter><TabFrame studyId="std_1" spies={spies}><VcrVersionComparison studyId="std_1" kind="population" onClose={() => {}} versions={[{ objectId: "pop_a", version: 1, label: "人群版本一", resultId: "res_a" }, { objectId: "pop_b", version: 2, label: "人群版本二", resultId: "res_b" }]} /></TabFrame></MemoryRouter>);
  const action = screen.getByRole("button", { name: "将比较请求放入研究对话" });
  expect(action).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText("第一个保存版本"), "pop_a:1");
  expect(action).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText("第二个保存版本"), "pop_b:2");
  await userEvent.click(action);
  expect(spies.openChat).toHaveBeenCalledWith(expect.stringContaining("人群版本一"), expect.objectContaining({ kind: "population", studyId: "std_1", objectId: "pop_a", version: 1, resultId: "res_a", compareTo: expect.objectContaining({ objectId: "pop_b", version: 2, resultId: "res_b" }) }));
  expect(spies.openChat.mock.calls[0][0]).not.toMatch(/std_|pop_|res_/);
});
