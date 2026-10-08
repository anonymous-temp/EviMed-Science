import { describe, expect, it } from "vitest";
import { LOGIN_DEFAULT_RETURN, loginAddress, loginReturnTarget } from "./loginReturn";

describe("the address a sign-in goes back to", () => {
  it("is carried to the login page whole, query and fragment included, and read back as it was", () => {
    const asked = { pathname: "/app/memory", search: "?tab=methods&q=%E8%83%8C%E6%99%AF", hash: "#CLM-001" };
    const login = loginAddress(asked);
    expect(login).toBe("/login?next=%2Fapp%2Fmemory%3Ftab%3Dmethods%26q%3D%25E8%2583%258C%25E6%2599%25AF%23CLM-001");
    expect(loginReturnTarget(login.split("?")[1])).toBe("/app/memory?tab=methods&q=%E8%83%8C%E6%99%AF#CLM-001");
  });

  it("leaves the plain login page for an address that is not a page inside the app", () => {
    for (const pathname of ["/", "/login", "/settings", "/api/auth/logout", "/application", "//evil.example/app/chat"]) {
      expect(loginAddress({ pathname })).toBe("/login");
    }
    expect(loginAddress({ pathname: "/app/chat", search: "?x=\n" })).toBe("/login");
  });

  it("falls to the front door for a next that is missing or hostile", () => {
    expect(LOGIN_DEFAULT_RETURN).toBe("/app/chat");
    expect(loginReturnTarget("")).toBe("/app/chat");
    for (const next of [
      "//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "javascript:alert(1)", "/login", "/app/../login", "/app/%2e%2e/login",
      "/app/%2f%2fevil.example", "/app/%5cevil.example", "/app//evil.example", "/app/chat%0d%0a", "/app/聊天",
    ]) {
      expect(loginReturnTarget(new URLSearchParams({ next }))).toBe("/app/chat");
    }
  });
});
