import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { normalizePath, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const VIRTUAL_MODULE = "virtual:openclaw-pdf-assets";
const RESOLVED_MODULE = `\0${VIRTUAL_MODULE}`;
const DIRECTORIES = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
  iccUrl: "iccs",
} as const;

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(filename);
      }
      if (!entry.isFile()) {
        throw new Error(`PDF.js assets must be regular files: ${filename}`);
      }
      return [filename];
    });
}

/** Keep PDF.js resources local and version-matched to the UI-owned library. */
export function controlUiPdfAssetsPlugin(): Plugin {
  let building = false;
  return {
    name: "control-ui-pdf-assets",
    configResolved(config) {
      building = config.command === "build";
    },
    resolveId(source) {
      return source === VIRTUAL_MODULE ? RESOLVED_MODULE : null;
    },
    load(id) {
      if (id !== RESOLVED_MODULE) {
        return null;
      }
      const packageFile = require.resolve("pdfjs-dist/package.json");
      const packageRoot = path.dirname(packageFile);
      const metadata: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("version" in metadata) ||
        typeof metadata.version !== "string" ||
        !/^\d+\.\d+\.\d+$/u.test(metadata.version)
      ) {
        throw new Error("PDF.js package version is missing or invalid");
      }
      const version = metadata.version;
      this.addWatchFile(packageFile);
      if (building) {
        const licenseFile = path.join(packageRoot, "LICENSE");
        this.addWatchFile(licenseFile);
        this.emitFile({
          type: "asset",
          fileName: `assets/pdfjs-${version}/LICENSE`,
          source: readFileSync(licenseFile),
        });
      }
      const properties = Object.entries(DIRECTORIES).map(([property, directory]) => {
        const directoryRoot = path.join(packageRoot, directory);
        if (!building) {
          const url = `/@fs/${normalizePath(directoryRoot)}/`;
          return `${JSON.stringify(property)}: ${JSON.stringify(url)}`;
        }
        let marker: string | undefined;
        for (const filename of collectFiles(directoryRoot)) {
          this.addWatchFile(filename);
          const relative = normalizePath(path.relative(directoryRoot, filename));
          const reference = this.emitFile({
            type: "asset",
            fileName: `assets/pdfjs-${version}/${directory}/${relative}`,
            source: readFileSync(filename),
          });
          if (!marker && path.dirname(filename) === directoryRoot) {
            marker = reference;
          }
        }
        if (!marker) {
          throw new Error(`PDF.js asset directory has no root files: ${directory}`);
        }
        // Let Vite resolve an emitted file URL relative to its owning chunk;
        // deriving the directory from that URL preserves mounted app bases.
        const url = `new URL("./", import.meta.ROLLUP_FILE_URL_${marker}).href`;
        return `${JSON.stringify(property)}: ${url}`;
      });
      return `export const pdfAssetUrls = {\n${properties.join(",\n")}\n};\n`;
    },
  };
}
