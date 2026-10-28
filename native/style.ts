// The look of the chrome, screens, HUD and tray: the browser build's
// index.html <style>, rewritten class-based in tools/ui-style.css and
// converted once with `starhermit css` into assets/ui-style.json (`npm run
// css`), registered at start with the theme the runtime's own widgets
// (dialogs, scroll bars, check boxes) take. The old html.high-contrast
// palette is a token set applied while the runtime's high-contrast option is
// on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** index.html html.high-contrast. */
const HIGH_CONTRAST: Tokens = {
  bg: "#000000", panel: "#0a0a0a", panel2: "#141414", ink: "#ffffff", muted: "#d8d8d8",
  accent: "#ffd400", danger: "#ff5a3c", ok: "#3cff9a", focus: "#00cfff", hud: "#000000e0", wash: "#000000f0",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.3, headingSize: 24, padding: 8, spacing: 10, radius: 10,
    text: "#eef3e8", muted: "#9fb3a4", panel: "#16241c", control: "#1d2f24", hovered: "#26392d",
    pressed: "#16241c", field: "#1d2f24", accent: "#e8c15a", focus: "#9fd8ff", outline: "#3a4f41",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "#9fd8ff", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#9fb3a4", radius: 4 } } },
    tooltip: { background: "$panel2", text: { color: "$ink" }, radius: 6, padding: 6 },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
