import { Component, type ReactNode } from "react";

/** A picture that cannot load (a chunk gone after a release, three.js refusing) is no reason for its page to fail: the page goes on without it. */
export class StarBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailed(); }
  render() { return this.state.failed ? null : this.props.children; }
}
