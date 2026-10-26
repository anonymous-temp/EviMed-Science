import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { toast, useToastStore } from "@/lib/toast";
import { Toaster } from "./Toaster";
afterEach(()=>{act(()=>{for(const item of useToastStore.getState().toasts)useToastStore.getState().dismiss(item.id);});});
it("shows a truthful visible repetition count for the same event and entity",()=>{
 render(<Toaster/>);act(()=>{toast.error('Unable to save',{eventId:'save',entityId:'draft'});toast.error('Unable to save',{eventId:'save',entityId:'draft'});});
 expect(screen.getByLabelText('重复 2 次')).toHaveTextContent('×2');
 const card=screen.getByLabelText('重复 2 次').closest('[data-toast]');expect(card).toHaveAttribute('data-toast-tone','error');expect(card).not.toHaveAttribute('role');expect(screen.getAllByText('Unable to save')).toHaveLength(1);
});
