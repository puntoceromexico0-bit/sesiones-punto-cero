// Compila el cliente del tablero para la versión independiente
// (Render) SIN el runtime de Muse: redirige los imports de
// "@hatch/space-sdk/client" y "@hatch/space-sdk/fields" a los
// adaptadores de ./shims y deja el resultado en ../server/public.
//
// Requiere Bun:  bun run deploy/client/build.mjs
// (las dependencias de compilación están en deploy/client/package.json;
//  en este repo ya están instaladas en la raíz).

import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPlugin from "bun-plugin-tailwind";

const here = path.dirname(fileURLToPath(import.meta.url));

const shimPlugin = {
  name: "space-sdk-shims",
  setup(build) {
    build.onResolve({ filter: /^@hatch\/space-sdk\/client$/ }, () => ({
      path: path.join(here, "shims", "space-sdk-client.tsx"),
    }));
    build.onResolve({ filter: /^@hatch\/space-sdk\/fields$/ }, () => ({
      path: path.join(here, "shims", "space-sdk-fields.ts"),
    }));
  },
};

const result = await Bun.build({
  entrypoints: [path.join(here, "index.tsx")],
  outdir: path.join(here, "..", "server", "public"),
  target: "browser",
  minify: true,
  plugins: [shimPlugin, tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

copyFileSync(
  path.join(here, "index.html"),
  path.join(here, "..", "server", "public", "index.html"),
);
console.log("Cliente independiente compilado en deploy/server/public/");
