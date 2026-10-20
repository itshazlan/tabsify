// Menyalin aset alphaTab (font, soundfont, worker) dari node_modules ke public/
// supaya tidak perlu di-commit ke repo. Dijalankan otomatis sebelum dev/build.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const dist = join(webRoot, "..", "..", "node_modules", "@coderline", "alphatab", "dist");
const publicDir = join(webRoot, "public");

if (!existsSync(dist)) {
  console.warn("[tabsify] @coderline/alphatab belum terinstall, aset reader dilewati");
  process.exit(0);
}

const copies = [
  [join(dist, "font", "Bravura.woff2"), join(publicDir, "font", "Bravura.woff2")],
  [join(dist, "font", "Bravura.woff"), join(publicDir, "font", "Bravura.woff")],
  [join(dist, "soundfont", "sonivox.sf2"), join(publicDir, "soundfont", "sonivox.sf2")],
  [join(dist, "alphaTab.worker.mjs"), join(publicDir, "assets", "alphaTab.worker.mjs")],
  [join(dist, "alphaTab.worklet.mjs"), join(publicDir, "assets", "alphaTab.worklet.mjs")],
  [join(dist, "alphaTab.core.mjs"), join(publicDir, "assets", "alphaTab.core.mjs")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`[tabsify] aset tidak ditemukan: ${from}`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

console.log(`[tabsify] ${copies.length} aset alphaTab disalin ke public/`);
