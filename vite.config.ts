import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const packageJson = JSON.parse(
readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };
let buildRevision = "dev";
try {
buildRevision = execSync("git rev-parse --short HEAD", {
encoding: "utf8",
}).trim();
} catch {
// Source archives without Git metadata fall back to "dev".
}
export default defineConfig({
plugins: [react()],
define: {
APP_VERSION: JSON.stringify(packageJson.version),
BUILD_REVISION: JSON.stringify(buildRevision),
},
build: {
rollupOptions: {
input: {
main: "index.html",
popout: "popout.html",
},
},
},
server: {
watch: {
ignored: ["**/src-tauri/target/**"],
},
},
});
