import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
  fetchWebAuthMethods: vi.fn(),
  loginWeb: vi.fn(),
  loginDevelopmentWeb: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
  fetchWebAuthMethods: mocks.fetchWebAuthMethods,
  loginWeb: mocks.loginWeb,
  loginDevelopmentWeb: mocks.loginDevelopmentWeb,
  getWebOidcStartUrl: () => "/api/auth/oidc/start?returnTo=%2Flive",
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue(null);
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local" });
    mocks.loginWeb.mockResolvedValue(undefined);
  });

  it("opens as a Chinese username/password login and enters the home page", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/live" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.type(await screen.findByPlaceholderText("请输入账号"), "alice");
    expect(screen.getByText(/不替代临床诊疗或专业判断/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("请输入密码"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(mocks.loginWeb).toHaveBeenCalledWith("alice", "secret"));
    expect(screen.getByTestId("location")).toHaveTextContent("/live");
  });

  it("redirects an existing session directly to the home page", async () => {
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "alice", name: "Alice" } });
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/live" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("location")).toHaveTextContent("/live");
  });
});
