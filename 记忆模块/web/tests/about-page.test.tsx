import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import About from "@/pages/About";

const mockInstance = {
  profile: {
    version: "0.25.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    instanceUrl: "",
    demo: false,
    admin: undefined as { username: string; displayName: string } | undefined,
  },
  generalSetting: {} as { customProfile?: { title: string; description: string; logoUrl: string } },
};

vi.mock("@/contexts/InstanceContext", () => ({
  useInstance: () => mockInstance,
}));

describe("<About>", () => {
  beforeEach(() => {
    mockInstance.profile = {
      version: "0.25.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      instanceUrl: "https://notes.example.com",
      demo: false,
      admin: { username: "steven", displayName: "Steven" },
    };
    mockInstance.generalSetting = {};
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders the EviMed identity hero with plain version and commit chips", () => {
    render(<About />);

    expect(screen.getByRole("heading", { name: "EviMed Science" })).toBeInTheDocument();
    expect(screen.getByText(/Memory module of the EviMed Science platform/i)).toBeInTheDocument();
    expect(screen.getByText("v0.25.0")).toBeInTheDocument();
    expect(screen.getByText("0123456")).toBeInTheDocument();
  });

  it("does not link to the former upstream project", () => {
    render(<About />);

    for (const link of screen.queryAllByRole("link")) {
      expect(link).not.toHaveAttribute("href", expect.stringContaining("usememos"));
    }
    expect(screen.queryByText(/Powered by Memos/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Memos" })).not.toBeInTheDocument();
  });

  it("does not surface the instance URL or administrator", () => {
    render(<About />);

    expect(screen.queryByText("https://notes.example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("Administrator")).not.toBeInTheDocument();
    expect(screen.queryByText("Steven")).not.toBeInTheDocument();
  });

  it("shows a plain version chip and no commit chip on dev builds", () => {
    mockInstance.profile.version = "dev";
    mockInstance.profile.commit = "unknown";

    render(<About />);

    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.queryByText("vdev")).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
  });

  it("shows the demo badge on demo instances", () => {
    mockInstance.profile.demo = true;

    render(<About />);

    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("uses custom branding for the identity hero when the admin configured it", () => {
    mockInstance.generalSetting = {
      customProfile: { title: "Team Notes", description: "Our shared scratchpad.", logoUrl: "/custom-logo.png" },
    };

    render(<About />);

    expect(screen.getByRole("heading", { name: "Team Notes" })).toBeInTheDocument();
    expect(screen.getByText("Our shared scratchpad.")).toBeInTheDocument();
  });

  it("does not add nested horizontal page padding on mobile", () => {
    const { container } = render(<About />);

    const contentWrapper = container.querySelector("section > div");

    expect(contentWrapper).toHaveClass("w-full");
    expect(contentWrapper).not.toHaveClass("px-4");
  });
});
