/**
 * Prepublish script for MQL Clangd extension
 * 1. Increments the patch version of the extension
 * 2. Updates the main entry point to point to the distribution file
 */
const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");

try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  // Increment patch version
  const versionParts = pkg.version.split(".");
  const patchVersion = parseInt(versionParts[versionParts.length - 1]) + 1;
  versionParts[versionParts.length - 1] = patchVersion;
  pkg.version = versionParts.join(".");

  // Update main entry point
  pkg.main = "./dist/extension.js";

  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4) + "\n");

  console.log(`Updated version to ${pkg.version} and main to ${pkg.main}`);
} catch (error) {
  console.error("Error updating package.json:", error);
  process.exit(1);
}

