/**
 * Afterpublish script for MQL Clangd extension
 *
 * This script reverts the main entry point back to the source file
 * after publishing is complete and cleans up the dist directory
 */
const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const distDir = path.join(__dirname, "..", "dist");

try {
  // Read the package.json file
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  // Update main entry point back to source
  pkg.main = "./src/extension.js";

  // Write the updated package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4) + "\n");

  console.log(`Reverted main to ${pkg.main}`);

  // Delete all files in dist directory
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir);
    for (const file of files) {
      const filePath = path.join(distDir, file);
      fs.rmSync(filePath, { recursive: true, force: true });
    }

    console.log(`dist directory contents removed.`);
  } else {
    console.log(`dist directory does not exist.`);
  }
} catch (error) {
  console.error("Error in afterpublish script:", error);
  process.exit(1);
}

