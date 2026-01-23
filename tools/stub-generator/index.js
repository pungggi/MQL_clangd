#!/usr/bin/env node

/**
 * MQL5 Stub Generator CLI
 * 
 * Generates clangd-compatible stub declarations from MQL5 Standard Library headers.
 * 
 * Usage:
 *   node index.js --input <mql5-include-path> --output <output-file>
 *   node index.js -i "C:/Program Files/MetaTrader 5/MQL5/Include" -o stubs.h
 * 
 * Options:
 *   -i, --input     Path to MQL5 Include directory
 *   -o, --output    Output file path (default: generated_stubs.h)
 *   -p, --pattern   Glob pattern for files to parse (default: ** /*.mqh)
 *   -d, --dirs      Specific subdirectories to parse (comma-separated)
 *   -v, --verbose   Enable verbose output
 *   --dry-run       Parse files but don't write output
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { MqlParser } = require('./parser');
const { StubGenerator } = require('./generator');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        input: null,
        output: 'generated_stubs.h',
        pattern: '**/*.mqh',
        dirs: null,
        verbose: false,
        dryRun: false,
        forwardOnly: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '-i':
            case '--input':
                options.input = args[++i];
                break;
            case '-o':
            case '--output':
                options.output = args[++i];
                break;
            case '-p':
            case '--pattern':
                options.pattern = args[++i];
                break;
            case '-d':
            case '--dirs':
                options.dirs = args[++i].split(',').map(d => d.trim());
                break;
            case '-v':
            case '--verbose':
                options.verbose = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '-f':
            case '--forward-only':
                options.forwardOnly = true;
                break;
            case '-h':
            case '--help':
                printHelp();
                process.exit(0);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
MQL5 Stub Generator - Generate clangd-compatible stubs from MQL5 headers

Usage:
  node index.js --input <mql5-include-path> --output <output-file>

Options:
  -i, --input        Path to MQL5 Include directory (required)
  -o, --output       Output file path (default: generated_stubs.h)
  -d, --dirs         Specific subdirectories to parse (comma-separated)
                     Example: -d "Trade,Controls,Arrays"
  -f, --forward-only Generate forward declarations only (no class definitions)
                     Use this to avoid conflicts with real MQL5 headers
  -v, --verbose      Enable verbose output
  --dry-run          Parse files but don't write output
  -h, --help         Show this help message

Examples:
  # Parse all headers in MQL5 Include
  node index.js -i "C:/Program Files/MetaTrader 5/MQL5/Include" -o stubs.h

  # Parse only Trade and Controls libraries
  node index.js -i "./Include" -d "Trade,Controls" -o trade_controls.h

  # Forward declarations only (avoids conflicts with actual headers)
  node index.js -i "./Include" -d "Trade,Controls" -o stubs.h --forward-only

  # Verbose dry run
  node index.js -i "./Include" -d "Trade" -v --dry-run
`);
}

// Recursively find .mqh files
function findMqhFiles(dir, baseDir = dir) {
    const files = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                files.push(...findMqhFiles(fullPath, baseDir));
            } else if (entry.isFile() && entry.name.endsWith('.mqh')) {
                files.push(fullPath);
            }
        }
    } catch (err) {
        console.error(`Warning: Cannot read directory ${dir}: ${err.message}`);
    }

    return files;
}

// Main function
async function main() {
    const options = parseArgs();

    // Validate input
    if (!options.input) {
        console.error('Error: Input path is required. Use -i or --input');
        console.error('Use --help for usage information');
        process.exit(1);
    }

    if (!fs.existsSync(options.input)) {
        console.error(`Error: Input path does not exist: ${options.input}`);
        process.exit(1);
    }

    console.log('MQL5 Stub Generator');
    console.log('===================');
    console.log(`Input: ${options.input}`);
    console.log(`Output: ${options.output}`);
    if (options.dirs) {
        console.log(`Directories: ${options.dirs.join(', ')}`);
    }
    console.log('');

    // Find files to parse
    let filesToParse = [];

    if (options.dirs) {
        for (const dir of options.dirs) {
            const dirPath = path.join(options.input, dir);
            if (fs.existsSync(dirPath)) {
                filesToParse.push(...findMqhFiles(dirPath));
            } else {
                console.warn(`Warning: Directory not found: ${dirPath}`);
            }
        }
    } else {
        filesToParse = findMqhFiles(options.input);
    }

    console.log(`Found ${filesToParse.length} .mqh files to parse`);

    if (filesToParse.length === 0) {
        console.error('Error: No .mqh files found');
        process.exit(1);
    }

    // Parse files
    const parser = new MqlParser();
    const parsedData = [];
    let successCount = 0;
    let errorCount = 0;

    for (const file of filesToParse) {
        const relativePath = path.relative(options.input, file);

        try {
            const source = fs.readFileSync(file, 'utf-8');
            const result = parser.parse(source, relativePath);

            if (result.classes.length > 0 || result.enums.length > 0) {
                parsedData.push(result);
                successCount++;

                if (options.verbose) {
                    console.log(`  ✓ ${relativePath}: ${result.classes.length} classes, ${result.enums.length} enums`);
                }
            }
        } catch (err) {
            errorCount++;
            if (options.verbose) {
                console.error(`  ✗ ${relativePath}: ${err.message}`);
            }
        }
    }

    console.log('');
    console.log(`Parsed: ${successCount} files with declarations, ${errorCount} errors`);

    // Count totals
    let totalClasses = 0;
    let totalEnums = 0;
    let totalMethods = 0;

    for (const data of parsedData) {
        totalClasses += data.classes.length;
        totalEnums += data.enums.length;
        for (const cls of data.classes) {
            totalMethods += cls.methods.length;
        }
    }

    console.log(`Total: ${totalClasses} classes, ${totalEnums} enums, ${totalMethods} methods`);

    // Generate output
    if (options.dryRun) {
        console.log('');
        console.log('Dry run - not writing output file');

        if (options.verbose) {
            console.log('');
            console.log('Classes found:');
            for (const data of parsedData) {
                for (const cls of data.classes) {
                    const base = cls.baseClass ? ` : ${cls.baseClass}` : '';
                    console.log(`  ${cls.name}${base} (${cls.methods.length} methods)`);
                }
            }
        }
    } else {
        console.log('');
        if (options.forwardOnly) {
            console.log('Generating forward declarations only...');
        } else {
            console.log('Generating stubs...');
        }

        const generator = new StubGenerator({
            includeProtected: true,
            includePrivate: false,
            forwardDeclOnly: options.forwardOnly
        });

        const output = generator.generateHeader(parsedData);

        // Write output file
        const outputDir = path.dirname(options.output);
        if (outputDir && !fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(options.output, output, 'utf-8');

        const stats = fs.statSync(options.output);
        console.log(`Written: ${options.output} (${(stats.size / 1024).toFixed(1)} KB)`);
    }

    console.log('');
    console.log('Done!');
}

// Run
main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});

