'use strict';
const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');
const { extractDocumentSymbols, obj_items } = require('./provider');
const { getEncoding } = require('js-tiktoken');
const TOML = require('smol-toml');

// Initialize tokenizer (cl100k_base is used by GPT-4/GPT-3.5)
const enc = getEncoding('cl100k_base');

// =============================================================================
// PROJECT CONTEXT GENERATOR
// Generates a context file (.toml or .md) for AI Agents and manual users
// =============================================================================

const STDLIB_CATEGORIES = {
    'Account': ['AccountInfoDouble', 'AccountInfoInteger', 'AccountInfoString'],
    'Trading': ['OrderSend', 'OrderClose', 'OrderModify', 'OrderDelete', 'PositionOpen', 'PositionClose', 'PositionModify'],
    'Market': ['SymbolInfoDouble', 'SymbolInfoInteger', 'SymbolInfoString', 'MarketInfo'],
    'Arrays': ['ArraySize', 'ArrayResize', 'ArrayCopy', 'ArraySort', 'ArrayMaximum', 'ArrayMinimum'],
    'Math': ['MathMax', 'MathMin', 'MathAbs', 'MathRound', 'MathFloor', 'MathCeil', 'MathPow', 'MathSqrt'],
    'Strings': ['StringLen', 'StringFind', 'StringSubstr', 'StringConcatenate', 'IntegerToString', 'DoubleToString'],
    'Time': ['TimeCurrent', 'TimeLocal', 'TimeGMT', 'iTime'],
    'Indicators': ['iMA', 'iRSI', 'iMACD', 'iBands', 'iATR', 'iStochastic']
};

let contextWatcher = null;
let debounceTimer = null;
const DEBOUNCE_MS = 2000;

/**
 * Validate and resolve format consistency between FileName and Format
 * @param {string} fileName - The configured FileName
 * @param {string} format - The configured Format
 * @returns {{ format: string, message: string|null }}
 */
function validateAndResolveFormat(fileName, format) {
    const ext = pathModule.extname(fileName).toLowerCase();
    let inferredFormat = null;

    if (ext === '.toml') {
        inferredFormat = 'toml';
    } else if (ext === '.md' || ext === '.markdown') {
        inferredFormat = 'markdown';
    }

    if (inferredFormat && inferredFormat !== format) {
        const msg = `[MQL Context] mql_tools.ProjectContext.FileName extension (${ext}) conflicts with mql_tools.ProjectContext.Format (${format}). Using format inferred from extension: ${inferredFormat}.`;
        vscode.window.showWarningMessage(msg);
        console.warn(msg);
        return { format: inferredFormat, message: msg };
    }

    return { format, message: null };
}

/**
 * Extract symbols from a file's text content (without needing a vscode.TextDocument)
 * @param {string} text - File content
 * @param {string} filePath - For reference
 * @returns {{ defines: Array, classes: Array, enums: Array, functions: Array, inputs: Array }}
 */
function extractSymbolsFromText(text, filePath) {
    const symbols = {
        defines: [],
        classes: [],
        enums: [],
        functions: [],
        inputs: [],
        includes: []
    };

    const mqlTypes = 'int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color|void';

    // Extract #include directives
    const includeRegex = /^#include\s+[<"]([^>"]+)[>"]/gm;
    let match;
    while ((match = includeRegex.exec(text)) !== null) {
        symbols.includes.push(match[1]);
    }

    // Extract #define macros
    const defineRegex = /^#define\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(.*))?/gm;
    while ((match = defineRegex.exec(text)) !== null) {
        symbols.defines.push({
            name: match[1],
            value: match[2] ? match[2].trim().substring(0, 50) : '' // Truncate long values
        });
    }

    // Extract enums
    const enumRegex = /^\s*enum\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{([^}]*)\}/gms;
    while ((match = enumRegex.exec(text)) !== null) {
        const enumName = match[1];
        const enumBody = match[2];
        const members = enumBody.split(',')
            .map(m => {
                const cleaned = m.replace(/\/\/.*$/, '').trim();
                return cleaned.split('=')[0].trim();
            })
            .filter(m => m);
        symbols.enums.push({ name: enumName, members: members.slice(0, 10) }); // Limit members
    }

    // Extract classes/structs with members
    const classRegex = /^\s*(class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*(?:public|protected|private)?\s*([a-zA-Z_][a-zA-Z0-9_]*))?\s*\{/gm;
    while ((match = classRegex.exec(text)) !== null) {
        const kind = match[1];
        const name = match[2];
        const base = match[3] || null;

        const STATE_NORMAL = 0;
        const STATE_SINGLE_QUOTE = 1;
        const STATE_DOUBLE_QUOTE = 2;
        const STATE_TEMPLATE = 3;
        const STATE_SINGLE_COMMENT = 4;
        const STATE_MULTI_COMMENT = 5;

        const startIdx = match.index + match[0].length;
        let braceCount = 1;
        let endIdx = startIdx;
        let state = STATE_NORMAL;
        let escapeNext = false;

        for (let i = startIdx; i < text.length && braceCount > 0; i++) {
            const ch = text[i];
            const nextCh = i + 1 < text.length ? text[i + 1] : '';

            if (escapeNext) {
                escapeNext = false;
            } else if (ch === '\\') {
                escapeNext = true;
            } else {
                switch (state) {
                    case STATE_NORMAL:
                        if (ch === '\'') state = STATE_SINGLE_QUOTE;
                        else if (ch === '"') state = STATE_DOUBLE_QUOTE;
                        else if (ch === '`') state = STATE_TEMPLATE;
                        else if (ch === '/' && nextCh === '/') { state = STATE_SINGLE_COMMENT; i++; }
                        else if (ch === '/' && nextCh === '*') { state = STATE_MULTI_COMMENT; i++; }
                        else if (ch === '{') braceCount++;
                        else if (ch === '}') braceCount--;
                        break;
                    case STATE_SINGLE_QUOTE:
                        if (ch === '\'') state = STATE_NORMAL;
                        break;
                    case STATE_DOUBLE_QUOTE:
                        if (ch === '"') state = STATE_NORMAL;
                        break;
                    case STATE_TEMPLATE:
                        if (ch === '`') state = STATE_NORMAL;
                        break;
                    case STATE_SINGLE_COMMENT:
                        if (ch === '\n') state = STATE_NORMAL;
                        break;
                    case STATE_MULTI_COMMENT:
                        if (ch === '*' && nextCh === '/') { state = STATE_NORMAL; i++; }
                        break;
                }
            }
            endIdx = i;
        }
        const classBody = text.substring(startIdx, endIdx);

        // Extract public members (simplified)
        const members = [];
        const memberRegex = new RegExp(`\\b(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*[;=\\[]`, 'g');
        let memberMatch;
        while ((memberMatch = memberRegex.exec(classBody)) !== null && members.length < 10) {
            members.push({ type: memberMatch[1], name: memberMatch[2] });
        }

        symbols.classes.push({ kind, name, base, members });
    }

    // Extract global functions (signatures only)
    const funcRegex = new RegExp(`^\\s*(?:static\\s+)?(?:virtual\\s+)?(?:export\\s+)?(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(([^)]*)\\)`, 'gm');
    while ((match = funcRegex.exec(text)) !== null) {
        const returnType = match[1];
        const funcName = match[2];
        const params = match[3].trim();

        // Skip event handlers (they're standard)
        if (['OnInit', 'OnDeinit', 'OnTick', 'OnTimer', 'OnTrade', 'OnTradeTransaction',
            'OnBookEvent', 'OnChartEvent', 'OnCalculate', 'OnTester', 'OnTesterInit',
            'OnTesterDeinit', 'OnTesterPass', 'OnStart'].includes(funcName)) {
            continue;
        }

        symbols.functions.push({
            signature: `${returnType} ${funcName}(${params})`
        });
    }

    // Extract input parameters
    const inputRegex = new RegExp(`^\\s*(input|sinput)\\s+(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)`, 'gm');
    while ((match = inputRegex.exec(text)) !== null) {
        symbols.inputs.push({
            kind: match[1],
            type: match[2],
            name: match[3]
        });
    }

    return symbols;
}

/**
 * Generate the Standard Library stub from obj_items
 * @param {boolean} includeStdLib
 * @returns {string}
 */
function generateStdLibStub(includeStdLib) {
    if (!includeStdLib) return '';

    let md = '\n## MQL Standard Library (High-Frequency Functions)\n\n';

    for (const [category, funcs] of Object.entries(STDLIB_CATEGORIES)) {
        const validFuncs = funcs.filter(f => obj_items[f]);
        if (validFuncs.length === 0) continue;

        md += `### ${category}\n`;
        for (const funcName of validFuncs) {
            const item = obj_items[funcName];
            if (item && item.code && item.code[0]) {
                md += `- \`${item.code[0].label}\`\n`;
            }
        }
        md += '\n';
    }

    return md;
}

/**
 * Generate the project context markdown content
 * @param {vscode.WorkspaceFolder} workspaceFolder
 * @param {object} config
 * @param {string} resolvedFormat - The resolved output format (toml or markdown)
 * @returns {Promise<string>}
 */
async function generateContextContent(workspaceFolder, config, resolvedFormat) {
    const scanMode = config.get('ProjectContext.ScanMode', 'IncludesOnly');
    const includeStdLib = config.get('ProjectContext.IncludeStdLib', true);
    const excludePatterns = config.get('ProjectContext.ExcludePatterns', []);

    const wsPath = workspaceFolder.uri.fsPath;
    const pattern = scanMode === 'IncludesOnly' ? '**/*.mqh' : '**/*.{mq4,mq5,mqh}';

    // Find all matching files
    const exclude = excludePatterns.length > 0
        ? `{${excludePatterns.join(',')},**/node_modules/**}`
        : `**/node_modules/**`;
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, pattern),
        exclude
    );

    // Aggregate symbols
    const allDefines = [];
    const allEnums = [];
    const allClasses = [];
    const allFunctions = [];
    const fileList = [];

    // Parallel file processing
    await Promise.all(files.map(async (fileUri) => {
        const relativePath = pathModule.relative(wsPath, fileUri.fsPath).replace(/\\/g, '/');

        try {
            const content = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
            const symbols = extractSymbolsFromText(content, fileUri.fsPath);

            fileList.push({ path: relativePath, includes: symbols.includes });

            for (const d of symbols.defines) {
                allDefines.push({ ...d, file: relativePath });
            }
            for (const e of symbols.enums) {
                allEnums.push({ ...e, file: relativePath });
            }
            for (const c of symbols.classes) {
                allClasses.push({ ...c, file: relativePath });
            }
            for (const f of symbols.functions) {
                allFunctions.push({ ...f, file: relativePath });
            }
        } catch (err) {
            console.error(`[MQL Context] Failed to process ${relativePath}: ${err.message}`);
        }
    }));

    // Sort lists for deterministic output
    fileList.sort((a, b) => a.path.localeCompare(b.path));
    allDefines.sort((a, b) => a.name.localeCompare(b.name));
    allEnums.sort((a, b) => a.name.localeCompare(b.name));
    allClasses.sort((a, b) => a.name.localeCompare(b.name));
    allFunctions.sort((a, b) => a.file.localeCompare(b.file) || a.signature.localeCompare(b.signature));

    // Build data object for TOML/Markdown
    const data = {
        meta: {
            workspace: workspaceFolder.name,
            generated: new Date().toISOString(),
            scanMode,
            filesIndexed: files.length
        },
        files: fileList.map(f => ({ path: f.path, includes: f.includes })),
        defines: allDefines.slice(0, 200),  // Limit for token efficiency
        enums: allEnums,
        classes: allClasses,
        functions: allFunctions.slice(0, 500)  // Limit for token efficiency
    };

    // Add standard library if enabled
    if (includeStdLib) {
        data.stdlib = generateStdLibData();
    }

    // Format based on resolved configuration
    if (resolvedFormat === 'toml') {
        return generateTomlOutput(data);
    } else {
        return generateMarkdownOutput(data, fileList, allDefines, allEnums, allClasses, allFunctions, includeStdLib);
    }
}

/**
 * Generate Standard Library data structure
 * @returns {object}
 */
function generateStdLibData() {
    const result = {};
    for (const [category, funcs] of Object.entries(STDLIB_CATEGORIES)) {
        result[category] = funcs
            .filter(f => obj_items[f] && obj_items[f].code && obj_items[f].code[0])
            .map(f => obj_items[f].code[0].label);
    }
    return result;
}

/**
 * Generate TOML formatted output
 * @param {object} data
 * @returns {string}
 */
function generateTomlOutput(data) {
    // Add comment header
    const header = `# MQL Project Context
# Auto-generated by MQL Clangd extension. Do not edit manually.
# Format: TOML (optimized for AI context engines)

`;
    try {
        return header + TOML.stringify(data);
    } catch (err) {
        console.error(`[MQL Context] TOML serialization failed: ${err.message}`);
        return header + `# ERROR: TOML serialization failed.\n# Reason: ${err.message}\n# The data object may contain circular references or unsupported types.\n`;
    }
}

/**
 * Generate Markdown formatted output (legacy)
 * @param {object} data
 * @param {Array} fileList
 * @param {Array} allDefines
 * @param {Array} allEnums
 * @param {Array} allClasses
 * @param {Array} allFunctions
 * @param {boolean} includeStdLib
 * @returns {string}
 */
function generateMarkdownOutput(data, fileList, allDefines, allEnums, allClasses, allFunctions, includeStdLib) {
    let md = `# MQL Project Context\n\n`;
    md += `> Auto-generated by MQL Clangd extension. Do not edit manually.\n\n`;
    md += `**Workspace**: ${data.meta.workspace}  \n`;
    md += `**Generated**: ${data.meta.generated}  \n`;
    md += `**Scan Mode**: ${data.meta.scanMode}  \n`;
    md += `**Files Indexed**: ${data.meta.filesIndexed}\n\n`;

    // Dependency Graph (Imports)
    md += `## File Dependencies\n\n`;
    const filesWithIncludes = fileList.filter(f => f.includes.length > 0);
    if (filesWithIncludes.length > 0) {
        md += '```mermaid\ngraph TD\n';
        for (const f of filesWithIncludes.slice(0, 100)) {
            const nodeId = f.path.replace(/[^a-zA-Z0-9]/g, '_');
            for (const inc of f.includes) {
                const target = fileList.find(candidate => candidate.path.endsWith(inc.replace(/\\/g, '/')));
                if (target) {
                    const targetId = target.path.replace(/[^a-zA-Z0-9]/g, '_');
                    if (nodeId !== targetId) {
                        md += `  ${nodeId}[${pathModule.basename(f.path)}] --> ${targetId}[${pathModule.basename(target.path)}]\n`;
                    }
                }
            }
        }
        md += '```\n\n';
    } else {
        md += '*No dependencies detected.*\n\n';
    }

    // File List
    md += `## Indexed Files\n\n`;
    for (const f of fileList.slice(0, 50)) {
        md += `- ${f.path}\n`;
    }
    if (fileList.length > 50) {
        md += `- ... and ${fileList.length - 50} more\n`;
    }
    md += '\n';

    // Defines
    if (allDefines.length > 0) {
        md += `## Defines (${allDefines.length})\n\n`;
        md += '| Name | Value | File |\n';
        md += '|------|-------|------|\n';
        for (const d of allDefines.slice(0, 100)) {
            const escapePipes = (v) => (v || '').replace(/\|/g, '\\|');
            md += `| \`${escapePipes(d.name)}\` | \`${escapePipes(d.value)}\` | ${escapePipes(d.file)} |\n`;
        }
        if (allDefines.length > 100) {
            md += `\n*... and ${allDefines.length - 100} more defines*\n`;
        }
        md += '\n';
    }

    // Enums
    if (allEnums.length > 0) {
        md += `## Enums (${allEnums.length})\n\n`;
        for (const e of allEnums) {
            md += `### ${e.name}\n`;
            md += `*File: ${e.file}*\n\n`;
            md += '```cpp\n';
            md += `enum ${e.name} { ${e.members.join(', ')}${e.members.length >= 10 ? ', ...' : ''} };\n`;
            md += '```\n\n';
        }
    }

    // Classes/Structs
    if (allClasses.length > 0) {
        md += `## Classes & Structs (${allClasses.length})\n\n`;
        for (const c of allClasses) {
            md += `### ${c.kind} ${c.name}${c.base ? ` : ${c.base}` : ''}\n`;
            md += `*File: ${c.file}*\n\n`;
            if (c.members.length > 0) {
                md += '```cpp\n';
                for (const m of c.members) {
                    md += `  ${m.type} ${m.name};\n`;
                }
                md += '```\n';
            }
            md += '\n';
        }
    }

    // Functions
    if (allFunctions.length > 0) {
        md += `## Functions (${allFunctions.length})\n\n`;
        const funcsByFile = {};
        for (const f of allFunctions) {
            if (!funcsByFile[f.file]) funcsByFile[f.file] = [];
            funcsByFile[f.file].push(f);
        }
        for (const [file, funcs] of Object.entries(funcsByFile)) {
            md += `### ${file}\n`;
            md += '```cpp\n';
            for (const f of funcs.slice(0, 20)) {
                md += `${f.signature};\n`;
            }
            if (funcs.length > 20) {
                md += `// ... and ${funcs.length - 20} more\n`;
            }
            md += '```\n\n';
        }
    }

    // Standard Library
    md += generateStdLibStub(includeStdLib);

    return md;
}


/**
 * Write the context file
 * @param {vscode.WorkspaceFolder} workspaceFolder
 */
async function writeContextFile(workspaceFolder) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const fileName = config.get('ProjectContext.FileName', '.mql-context.toml');
    const format = config.get('ProjectContext.Format', 'toml');
    const maxTokens = config.get('ProjectContext.MaxTokens', 100000);

    const { format: resolvedFormat } = validateAndResolveFormat(fileName, format);
    const filePath = pathModule.join(workspaceFolder.uri.fsPath, fileName);

    try {
        const content = await generateContextContent(workspaceFolder, config, resolvedFormat);

        // Token Count Warning
        const warningHeader = `> ⚠️ **WARNING**: This file is **${enc.encode(content).length.toLocaleString()} tokens** (exceeds ${maxTokens.toLocaleString()}). It may exceed your AI context window.\n\n`;
        const finalContent = warningHeader + content;
        const tokens = enc.encode(finalContent).length;
        if (maxTokens > 0 && tokens > maxTokens) {
            const msg = `[MQL Context] Warning: Generated context is ${tokens.toLocaleString()} tokens (exceeds ${maxTokens.toLocaleString()}). Costs may be high.`;
            vscode.window.showWarningMessage(msg);
            console.warn(msg);

            // Inject warning into the markdown file itself
            await fs.promises.writeFile(filePath, finalContent, 'utf-8');
        } else {
            await fs.promises.writeFile(filePath, content, 'utf-8');
        }

        console.log(`[MQL Context] Updated: ${filePath} (${tokens} tokens)`);
    } catch (err) {
        console.error(`[MQL Context] Error writing context file: ${err.message}`);
    }
}

/**
 * Debounced update handler
 * @param {vscode.WorkspaceFolder} workspaceFolder
 */
function scheduleUpdate(workspaceFolder) {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        writeContextFile(workspaceFolder);
    }, DEBOUNCE_MS);
}

/**
 * Initialize the context file watcher
 * @param {vscode.ExtensionContext} context - The extension context
 * @param {vscode.WorkspaceFolder} workspaceFolder - The workspace folder to watch for file changes
 */
function initializeContextWatcher(context, workspaceFolder) {
    // Dispose existing watcher if any
    if (contextWatcher) {
        contextWatcher.dispose();
    }

    const config = vscode.workspace.getConfiguration('mql_tools');
    const autoUpdate = config.get('ProjectContext.EnableAutoUpdate', true);

    if (!autoUpdate) {
        return;
    }

    // Watch for MQL file changes
    const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5,mqh}');
    contextWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    contextWatcher.onDidChange(() => scheduleUpdate(workspaceFolder));
    contextWatcher.onDidCreate(() => scheduleUpdate(workspaceFolder));
    contextWatcher.onDidDelete(() => scheduleUpdate(workspaceFolder));

    context.subscriptions.push(contextWatcher);
}

/**
 * Activate Project Context command handler
 * @param {vscode.ExtensionContext} context
 */
async function activateProjectContext(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const workspaceFolder = workspaceFolders[0];

    // Generate initial context file
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'MQL: Generating Project Context...',
            cancellable: false
        },
        async () => {
            await writeContextFile(workspaceFolder);
        }
    );

    // Initialize watcher
    initializeContextWatcher(context, workspaceFolder);

    // Store activation state
    context.workspaceState.update('projectContextActivated', true);

    const config = vscode.workspace.getConfiguration('mql_tools');
    const fileName = config.get('ProjectContext.FileName', '.mql-context.toml');
    vscode.window.showInformationMessage(`MQL Project Context activated. File: ${fileName}`);
}

/**
 * Check if context was previously activated and restore watcher
 * @param {vscode.ExtensionContext} context
 */
function restoreContextWatcher(context) {
    const activated = context.workspaceState.get('projectContextActivated', false);
    if (activated && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        initializeContextWatcher(context, vscode.workspace.workspaceFolders[0]);
    }
}

module.exports = {
    activateProjectContext,
    restoreContextWatcher,
    initializeContextWatcher
};
