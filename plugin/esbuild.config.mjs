/* global process, console */
// Builds main.js for Obsidian. `node esbuild.config.mjs` watches; `… production` builds once,
// minified. Set ALPHAINO_VAULT to a vault folder to also copy the plugin into its
// .obsidian/plugins/alphaino after each build.
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv[2] === "production";

// The shared packages are built from AlphainZ's source: from the AlphainZ repository next to this one
// when developing, from the copy in shared/ in the public repository (the export that makes it points
// these paths there). ALPHAINZ_PACKAGES and ALPHAINZ_I18N override them.
const sharedPackages = path.resolve(here, process.env.ALPHAINZ_PACKAGES ?? "./shared/packages");
const sharedI18n = path.resolve(here, process.env.ALPHAINZ_I18N ?? "./shared/src/i18n");

const external = [
  "obsidian",
  "electron",
  "@codemirror/*",
  "@lezer/*",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];
const isExternal = (spec) =>
  external.some((name) => (name.endsWith("/*") ? spec.startsWith(name.slice(0, -1)) : spec === name || spec.startsWith(`${name}/`)));

/**
 * A bare import written inside a shared package would otherwise resolve to the
 * AlphainZ repository's node_modules, giving the bundle a second React (hooks
 * break) and a second jotai (atoms from one store are invisible to the other).
 * Every bare import from outside this repository is resolved from here instead.
 */
/** AlphainZ's hover tooltips are left out: every import of the shared Tooltip gets src/view/NoTooltip.tsx. */
const noTooltips = {
  name: "no-tooltips",
  setup(build) {
    build.onResolve({ filter: /Tooltip$/ }, (args) => {
      const shared = args.path === "@beaver/agent-ui/primitives/Tooltip";
      const relativeInShared =
        /(^\.\/|\/primitives\/)Tooltip$/.test(args.path) && args.importer.includes(`${path.sep}agent-ui${path.sep}src${path.sep}`);
      return shared || relativeInShared ? { path: path.join(here, "src", "view", "NoTooltip.tsx") } : undefined;
    });
  },
};

const oneCopyOfEachDependency = {
  name: "one-copy-of-each-dependency",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === "from-alphaino" || isExternal(args.path)) return undefined;
      if (args.path.startsWith("@beaver/") || args.path.startsWith("@alphainz/")) return undefined;
      if (!args.importer || args.importer.startsWith(here + path.sep)) return undefined;
      return build.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: "from-alphaino" });
    });
  },
};

const outdir = path.join(here, "build");

/** AlphainZ's own sheet, where the rules for many shared components still live (tooltips, chips, menus). */
const alphainzSheet = path.resolve(
  here,
  process.env.ALPHAINZ_STYLES ?? path.join(sharedPackages, "..", "addon", "content", "styles", "beaver.css"),
);

/**
 * The rules of a stylesheet scoped to AlphainZ's panes (`[id^="alphainz-pane-"] …`),
 * re-scoped to `.alphainz-root`. Anything else is left out: rules for Zotero's own
 * windows, and the reset that undoes every button's style inside AlphainZ's
 * panes (Obsidian's buttons in the chat keep Obsidian's look). Keyframes are kept.
 */
function paneRules(css) {
  const PANE = '[id^="alphainz-pane-"]';
  const out = [];
  let i = 0;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockEnd = (start) => {
    let depth = 0;
    for (let j = start; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) return j;
    }
    return text.length - 1;
  };
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const head = text.slice(i, open).trim();
    const close = blockEnd(open);
    const body = text.slice(open + 1, close);
    i = close + 1;
    if (head.startsWith("@keyframes")) {
      out.push(`${head} {${body}}`);
      continue;
    }
    if (head.startsWith("@media") || head.startsWith("@supports")) {
      const inner = paneRules(body);
      if (inner.trim()) out.push(`${head} {\n${inner}\n}`);
      continue;
    }
    if (head.startsWith("@")) continue;
    const all = head.split(",").map((part) => part.trim()).filter(Boolean);
    if (all.length === 0 || !all.every((selector) => selector.startsWith(PANE))) continue;
    if (all.some((selector) => /^\[id\^="alphainz-pane-"\]\s+(button|textarea|input)$/.test(selector))) continue;
    // Only what is inside a pane: rules for the pane element itself (display, flex, height) would lay out
    // AlphainO's view as AlphainZ lays out its pane.
    const selectors = all.filter((selector) => /^\s/.test(selector.slice(PANE.length)));
    if (selectors.length === 0) continue;
    const scoped = selectors.map((selector) => `.alphainz-root${selector.slice(PANE.length)}`).join(",\n");
    out.push(`${scoped} {${body}}`);
  }
  return out.join("\n");
}

/**
 * styles.css: the shared AlphainZ sheets (agent-ui's tokens, components and
 * utilities), Obsidian's colours for their token contract, AlphainZ's own
 * pane rules (re-scoped, see `paneRules`), then AlphainO's own.
 * The shared tokens are moved from `:root` onto `.alphainz-root`, so nothing
 * leaks into the rest of Obsidian, and their rem lengths onto `--alphainz-rem`.
 */
function buildStyles() {
  const theme = path.join(sharedPackages, "agent-ui", "src", "theme");
  const shared = (name) =>
    readFileSync(path.join(theme, name), "utf8")
      .replace(/:root\s*\{/g, ".alphainz-root {")
      .replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `calc(${n} * var(--alphainz-rem, 13px))`);
  const rems = (css) => css.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `calc(${n} * var(--alphainz-rem, 13px))`);
  const own = (name) => readFileSync(path.join(here, "styles", name), "utf8");
  const parts = [
    ["agent-ui-tokens.css", shared("agent-ui-tokens.css")],
    ["obsidian-theme.css", own("obsidian-theme.css")],
    ["agent-ui-components.css", shared("agent-ui-components.css")],
    ["agent-ui-utilities.css", shared("agent-ui-utilities.css")],
    ["beaver.css (AlphainZ's pane rules)", rems(paneRules(readFileSync(alphainzSheet, "utf8")))],
    // AlphainO's own sheet copies some of AlphainZ's lengths (chips, rows); they are in AlphainZ's rem too.
    ["alphaino.css", rems(own("alphaino.css"))],
  ];
  writeFileSync(
    path.join(outdir, "styles.css"),
    parts.map(([name, css]) => `/* ===== ${name} ===== */\n${css.trim()}\n`).join("\n"),
  );
}
const installInto = process.env.ALPHAINO_VAULT
  ? path.join(process.env.ALPHAINO_VAULT, ".obsidian", "plugins", "alphaino")
  : null;
const install = {
  name: "install-into-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      copyFileSync(path.join(here, "manifest.json"), path.join(outdir, "manifest.json"));
      buildStyles();
      if (!installInto) return;
      mkdirSync(installInto, { recursive: true });
      for (const name of ["main.js", "manifest.json", "styles.css"]) {
        copyFileSync(path.join(outdir, name), path.join(installInto, name));
      }
      console.log(`installed into ${installInto}`);
    });
  },
};

mkdirSync(outdir, { recursive: true });
const context = await esbuild.context({
  entryPoints: [path.join(here, "src/main.ts")],
  bundle: true,
  format: "cjs",
  target: "es2021",
  platform: "browser",
  outfile: path.join(outdir, "main.js"),
  external,
  alias: {
    "@beaver/agent-core": path.join(sharedPackages, "agent-core", "src"),
    "@beaver/agent-llm": path.join(sharedPackages, "agent-llm", "src"),
    "@beaver/agent-ui": path.join(sharedPackages, "agent-ui", "src"),
    "@alphainz/i18n": sharedI18n,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
  jsx: "transform",
  // Obsidian's skills (skills/, see src/skills) are bundled as their text.
  loader: { ".md": "text" },
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  plugins: [noTooltips, oneCopyOfEachDependency, install],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
if (!existsSync(path.join(outdir, "main.js"))) process.exitCode = 1;
