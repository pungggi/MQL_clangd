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
const readline = require('readline');
const { MqlParser } = require('./parser');
const { StubGenerator } = require('./generator');

// Helper to prompt user for input
function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

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
        forwardOnly: false,
        merge: false,
        force: false,
        fallback: false
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
            case '-m':
            case '--merge':
                options.merge = true;
                break;
            case '--force':
                options.force = true;
                break;
            case '--fallback':
                options.fallback = true;
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
  -m, --merge        Merge with existing output file (add new, keep existing)
   --force            Overwrite existing file without prompting
   --fallback         Automatically use all files when directory filter matches nothing
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

    // Normalize input path - be forgiving with trailing slashes, quotes, etc.
    options.input = options.input
        .replace(/^["']|["']$/g, '')     // Remove surrounding quotes
        .replace(/[\\/]+$/g, '')          // Remove trailing slashes (both / and \)
        .trim();

    // Normalize output path too
    if (options.output) {
        options.output = options.output
            .replace(/^["']|["']$/g, '')
            .trim();
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
    const allFiles = findMqhFiles(options.input);

    if (options.dirs) {
        // Try multiple matching strategies for flexibility
        for (const dir of options.dirs) {
            const dirPath = path.join(options.input, dir);

            // Strategy 1: Exact directory match
            if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                filesToParse.push(...findMqhFiles(dirPath));
                continue;
            }

            // Strategy 2: Case-insensitive directory match
            const dirLower = dir.toLowerCase();
            try {
                const entries = fs.readdirSync(options.input, { withFileTypes: true });
                const matchedDir = entries.find(e =>
                    e.isDirectory() && e.name.toLowerCase() === dirLower
                );
                if (matchedDir) {
                    const matchedPath = path.join(options.input, matchedDir.name);
                    filesToParse.push(...findMqhFiles(matchedPath));
                    console.log(`  Matched directory: ${matchedDir.name}`);
                    continue;
                }
            } catch (err) {
                // Ignore read errors
            }

            // Strategy 3: Filter files by pattern (filename contains the pattern)
            const patternLower = dir.toLowerCase();
            const matchedFiles = allFiles.filter(f => {
                const baseName = path.basename(f, '.mqh').toLowerCase();
                const relativePath = path.relative(options.input, f).toLowerCase();
                return baseName.includes(patternLower) || relativePath.includes(patternLower);
            });

            if (matchedFiles.length > 0) {
                filesToParse.push(...matchedFiles);
                console.log(`  Pattern "${dir}" matched ${matchedFiles.length} files`);
            } else {
                console.warn(`Warning: No matches for "${dir}" (tried directory and filename patterns)`);
            }
        }

        // Remove duplicates
        filesToParse = [...new Set(filesToParse)];

        // Fallback: if nothing matched but we have files, require explicit consent
        if (filesToParse.length === 0 && allFiles.length > 0) {
            console.log('');
            console.log(`No matches for specified directories, but found ${allFiles.length} .mqh files in input path.`);

            let useFallback = false;

            if (options.fallback) {
                // User explicitly enabled fallback via CLI flag
                useFallback = true;
                console.log('Fallback enabled via --fallback flag.');
            } else {
                // Prompt user for confirmation
                const answer = await prompt('No files matched the specified directories. Use all files instead? [y/N]: ');
                useFallback = answer === 'y' || answer === 'yes';
            }

            if (useFallback) {
                filesToParse = allFiles;
                console.log('Falling back to parsing all files...');
            }
        }
    } else {
        filesToParse = allFiles;
    }

    console.log(`Found ${filesToParse.length} .mqh files to parse`);

    if (filesToParse.length === 0) {
        console.error('Error: No .mqh files found');

        // Help the user by showing what's available
        try {
            const entries = fs.readdirSync(options.input, { withFileTypes: true });
            const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            const mqhFiles = entries.filter(e => e.isFile() && e.name.endsWith('.mqh')).map(e => e.name);

            if (subdirs.length > 0) {
                console.log(`\nAvailable subdirectories: ${subdirs.slice(0, 10).join(', ')}${subdirs.length > 10 ? '...' : ''}`);
            }
            if (mqhFiles.length > 0) {
                console.log(`Files in root: ${mqhFiles.slice(0, 5).join(', ')}${mqhFiles.length > 5 ? `... (${mqhFiles.length} total)` : ''}`);
            }
        } catch (err) {
            // Ignore
        }

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

        let output = generator.generateHeader(parsedData);

        // Ensure output directory exists
        const outputDir = path.dirname(options.output);
        if (outputDir && !fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Check if output file exists
        const fileExists = fs.existsSync(options.output);

        if (fileExists && !options.force && !options.merge) {
            // Interactive prompt
            const existingStats = fs.statSync(options.output);
            console.log(`\nOutput file already exists: ${options.output} (${(existingStats.size / 1024).toFixed(1)} KB)`);
            console.log('');
            console.log('Options:');
            console.log('  [m]erge     - Add new declarations, keep existing ones');
            console.log('  [o]verwrite - Replace file completely');
            console.log('  [c]ancel    - Abort without changes');
            console.log('');

            const answer = await prompt('Choose action [m/o/c]: ');

            if (answer === 'c' || answer === 'cancel') {
                console.log('Cancelled.');
                process.exit(0);
            } else if (answer === 'm' || answer === 'merge') {
                options.merge = true;
            } else if (answer !== 'o' && answer !== 'overwrite') {
                console.log('Invalid choice. Aborting.');
                process.exit(1);
            }
        }

        // Handle merge mode
        if (fileExists && options.merge) {
            const existingContent = fs.readFileSync(options.output, 'utf-8');

            // Extract existing class, struct, and enum names (Comment 8)
            const existingClasses = new Set();
            const existingStructs = new Set();
            const existingEnums = new Set();

            // Match class declarations: class ClassName or class ClassName :
            const classPattern = /^class\s+(\w+)\s*[:{]/gm;
            let match;
            while ((match = classPattern.exec(existingContent)) !== null) {
                existingClasses.add(match[1]);
            }

            // Match struct declarations: struct StructName or struct StructName {
            const structPattern = /^struct\s+(\w+)\s*\{/gm;
            while ((match = structPattern.exec(existingContent)) !== null) {
                existingStructs.add(match[1]);
            }

            // Match enum declarations: enum EnumName {
            const enumPattern = /^enum\s+(\w+)\s*\{/gm;
            while ((match = enumPattern.exec(existingContent)) !== null) {
                existingEnums.add(match[1]);
            }

            // Filter parsed data to only include new declarations
            let newClasses = 0;
            let newEnums = 0;

            for (const data of parsedData) {
                data.classes = data.classes.filter(cls => {
                    // Check both classes and structs sets based on kind (Comment 8)
                    const isStruct = cls.kind === 'struct';
                    const existingSet = isStruct ? existingStructs : existingClasses;
                    if (!existingSet.has(cls.name)) {
                        newClasses++;
                        return true;
                    }
                    return false;
                });
                data.enums = data.enums.filter(e => {
                    if (!existingEnums.has(e.name)) {
                        newEnums++;
                        return true;
                    }
                    return false;
                });
            }

            if (newClasses === 0 && newEnums === 0) {
                console.log('No new declarations to add. File unchanged.');
            } else {
                console.log(`Merging: ${newClasses} new classes, ${newEnums} new enums`);

                // Generate only the new declarations
                const newOutput = generator.generateHeader(parsedData);

                // Find where to insert (before the closing #endif)
                const endifIndex = existingContent.lastIndexOf('#endif');
                if (endifIndex !== -1) {
                    // Insert new content before #endif
                    const beforeEndif = existingContent.substring(0, endifIndex);
                    const afterEndif = existingContent.substring(endifIndex);

                    // Extract just the declaration content from new output (skip header/footer)
                    const contentStart = newOutput.indexOf('// Forward declarations');
                    const contentEnd = newOutput.lastIndexOf('#endif');

                    if (contentStart > 0 && contentEnd > contentStart) {
                        const newDeclarations = newOutput.substring(contentStart, contentEnd);
                        output = beforeEndif + '\n// === Merged declarations ===\n' + newDeclarations + '\n' + afterEndif;
                    } else {
                        output = beforeEndif + '\n// === Merged declarations ===\n' + newOutput + '\n' + afterEndif;
                    }
                } else {
                    // No #endif found, just append
                    output = existingContent + '\n// === Merged declarations ===\n' + newOutput;
                }

                fs.writeFileSync(options.output, output, 'utf-8');
                const stats = fs.statSync(options.output);
                console.log(`Merged: ${options.output} (${(stats.size / 1024).toFixed(1)} KB)`);
            }
        } else {
            // Overwrite mode
            fs.writeFileSync(options.output, output, 'utf-8');
            const stats = fs.statSync(options.output);
            console.log(`Written: ${options.output} (${(stats.size / 1024).toFixed(1)} KB)`);
        }
    }

    console.log('');
    console.log('Done!');
}

// Run
main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});

