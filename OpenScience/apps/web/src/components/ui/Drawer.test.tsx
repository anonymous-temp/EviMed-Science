import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Drawer } from "./Drawer";
it("guards X, Escape and backdrop through the same dirty-draft confirmation",async()=>{
 const close=vi.fn();render(<Drawer title="Draft" dirty onClose={close}><input aria-label="Name"/></Drawer>);
 await userEvent.keyboard('{Escape}');expect(screen.getByRole('alertdialog')).toBeInTheDocument();expect(close).not.toHaveBeenCalled();
 await userEvent.keyboard('{Escape}');expect(screen.queryByRole('alertdialog')).toBeNull();expect(close).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('dialog').parentElement!);expect(screen.getByRole('alertdialog')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:'取消'}));await userEvent.click(screen.getByRole('button',{name:'关闭'}));
 expect(screen.getByRole('alertdialog')).toBeInTheDocument();await userEvent.click(screen.getByRole('button',{name:'放弃修改'}));expect(close).toHaveBeenCalledOnce();
});

it("never renders implementation comments as visible drawer content",()=>{
 const {container}=render(<Drawer title="Preview" onClose={()=>{}}>Reader content</Drawer>);
 expect(container).not.toHaveTextContent(/keyboard equivalent|backdrop has no keyboard|role="presentation"/);
 expect(screen.getByRole('dialog')).toHaveTextContent('Reader content');
});
