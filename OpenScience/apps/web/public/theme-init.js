// Applies the reader's saved theme before the first paint (index.html loads
// this synchronously in <head>). Without it a dark-mode reader saw a light
// flash on every load until the bundle ran ThemeProvider. A file rather than
// an inline script, because the shell's CSP allows scripts from 'self' only.
// Keep in step with ThemeProvider: key "ai4s.theme"; light | dark | system.
(function () {
  try {
    var saved = window.localStorage.getItem("ai4s.theme");
    var dark = saved === "dark"
      || (saved !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (error) {
    // Storage unavailable: ThemeProvider decides once the bundle runs.
  }
})();
