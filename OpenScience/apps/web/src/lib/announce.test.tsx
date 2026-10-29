import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Announcer, announce } from "./announce";
afterEach(()=>vi.useRealTimers());
it("pre-mounts both channels and deduplicates semantic identity while queuing events",()=>{
 vi.useFakeTimers();render(<Announcer/>);expect(document.querySelector('[data-announcer="polite"]')).toBeEmptyDOMElement();
 act(()=>{announce("Saved",{eventId:"save",entityId:"a"});announce("  Saved  ",{eventId:"save",entityId:"a"});announce("Disconnected",{eventId:"disconnect",entityId:"b",politeness:"assertive"});vi.advanceTimersByTime(50);});
 expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("Saved");
 act(()=>vi.advanceTimersByTime(1050));expect(document.querySelector('[data-announcer="assertive"]')).toHaveTextContent("Disconnected");
});

it("keeps changed text, priority escalation and different entities as distinct announcements",()=>{
 vi.useFakeTimers();render(<Announcer/>);
 act(()=>{announce('First',{eventId:'priority-test',entityId:'a'});announce('Changed',{eventId:'priority-test',entityId:'a'});announce('First',{eventId:'priority-test',entityId:'a',politeness:'assertive'});announce('First',{eventId:'priority-test',entityId:'b'});vi.advanceTimersByTime(50);});
 expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent('First');act(()=>vi.advanceTimersByTime(1050));expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent('Changed');
 act(()=>vi.advanceTimersByTime(1050));expect(document.querySelector('[data-announcer="assertive"]')).toHaveTextContent('First');act(()=>vi.advanceTimersByTime(1050));expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent('First');
});

it("keeps permanent live channels without claiming page loading or error roles",()=>{
 render(<><Announcer/><p role="status">Reading</p><p role="alert">Local urgent failure</p></>);
 expect(screen.getByRole('status')).toHaveTextContent('Reading');expect(screen.getByRole('alert')).toHaveTextContent('Local urgent failure');
 for(const channel of document.querySelectorAll('[data-announcer]')) {expect(channel).toHaveAttribute('aria-atomic','true');expect(channel).toHaveAttribute('aria-live',channel.getAttribute('data-announcer'));expect(channel).not.toHaveAttribute('role');}
});

it("clears current and queued account text on both boundaries and rejects stale producers", async () => {
 const { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, sessionGeneration } = await import("./sessionLifecycle");
 vi.useFakeTimers(); const { unmount } = render(<Announcer/>); const owner = sessionGeneration();
 act(() => { announce("A private current", { eventId:"scope", entityId:"a" }); announce("A private queued", {eventId:"scope",entityId:"b"}); vi.advanceTimersByTime(50); });
 expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("A private current");
 act(() => { window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); });
 expect(document.querySelector('[data-announcer="polite"]')).toBeEmptyDOMElement();
 unmount(); window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); render(<Announcer/>);
 act(() => { announce("late A", {eventId:"late",entityId:"a",sessionGeneration:owner}); vi.advanceTimersByTime(5000); });
 expect(document.querySelector('[data-announcer="polite"]')).toBeEmptyDOMElement();
 act(() => { announce("B", {eventId:"scope",entityId:"a"}); vi.advanceTimersByTime(50); });
 expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("B");
 act(() => { window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); });
 expect(document.querySelector('[data-announcer="polite"]')).toBeEmptyDOMElement();
});
