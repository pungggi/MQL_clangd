'use strict';
const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');

/**
 * Normalizes paths for clangd (forward slashes).
 * @param {string} p
 */
function normalizePath(p) {
    if (!p) return '';
    return p.replace(/\\/g, '/');
}

/**
 * Expand a minimal, supported subset of VS Code variables in user-provided paths.
 * We intentionally keep this small and predictable.
 *
 * Supported:
 * - ${workspaceFolder}
 * - ${workspaceFolderBasename}
 *
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function expandWorkspaceVariables(inputPath, workspaceFolderPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const trimmed = inputPath.trim();

    if (!workspaceFolderPath) return trimmed;

    return trimmed
        .replace(/\$\{workspaceFolder\}/gi, workspaceFolderPath)
        .replace(/\$\{workspaceFolderBasename\}/gi, pathModule.basename(workspaceFolderPath));
}

/**
 * Resolve a configured path value against the current workspace folder.
 * - Expands ${workspaceFolder} variables.
 * - If the result is relative, resolves it against workspaceFolderPath.
 * - If the result is absolute, normalizes/removes '..' segments.
 *
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function resolvePathRelativeToWorkspace(inputPath, workspaceFolderPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const expanded = expandWorkspaceVariables(inputPath, workspaceFolderPath);
    if (!expanded) return expanded;

    if (pathModule.isAbsolute(expanded)) {
        return pathModule.resolve(expanded);
    }

    if (!workspaceFolderPath) return expanded;
    return pathModule.resolve(workspaceFolderPath, expanded);
}

/**
 * Checks if a file extension is a valid MQL source extension.
 * Source extensions are .mq4, .mq5, and .mqh.
 * Compiled extensions (.ex4, .ex5) are NOT source extensions.
 * @param {string} ext - The file extension to check (e.g., '.mq4')
 * @returns {boolean} - True if it's a source extension, false otherwise
 */
function isSourceExtension(ext) {
    if (!ext) return false;
    const normalized = ext.toLowerCase();
    return ['.mq4', '.mq5', '.mqh'].includes(normalized);
}

/**
 * Generates the portable switch string for MetaEditor commands.
 * @param {boolean} portableMode - Whether portable mode is enabled
 * @returns {string} - Empty string or ' /portable'
 */
function generatePortableSwitch(portableMode) {
    return portableMode ? ' /portable' : '';
}

/**
 * Generates an include flag for the compiler.
 * Uses normalized forward-slash paths for clangd compatibility.
 * @param {string} includePath - The include path
 * @returns {string} - The include flag (e.g., '-I/path/to/include')
 */
function generateIncludeFlag(includePath) {
    const normalized = normalizePath(includePath);
    return `-I${normalized}`;
}

/**
 * Generates the base compiler flags for clangd.
 * These are pure flags without path-dependent includes.
 * @param {Object} options - Optional configuration
 * @param {string} [options.compatHeaderPath] - Path to compatibility header
 * @param {string} [options.workspacePath] - Workspace path for include
 * @param {string} [options.includePath] - Include directory path
 * @returns {string[]} - Array of base compiler flags
 */
function generateBaseFlags(options = {}) {
    const flags = [
        '-xc++',
        '-std=c++17',
        '-D__MQL__',
        '-D__MQL5__',
        '-fms-extensions',
        '-fms-compatibility',
        '-ferror-limit=0',
        '-Wno-invalid-token-paste',
        '-Wno-unused-value',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',
        '-Xclang', '-Wno-invalid-pp-directive',
        '-Wno-unknown-directives',
        '-Wno-language-extension-token'
    ];

    // Add optional path-dependent flags
    if (options.compatHeaderPath) {
        flags.splice(4, 0, `-include${options.compatHeaderPath}`);
    }
    if (options.workspacePath) {
        flags.push(`-I${normalizePath(options.workspacePath)}`);
    }
    if (options.includePath) {
        flags.push(`-I${normalizePath(options.includePath)}`);
    }

    return flags;
}

/**
 * Generates project-specific flags based on MQL version.
 * Transforms base flags for MQL4 projects (replaces __MQL5__ with __MQL4__).
 * @param {'mql4' | 'mql5'} projectType - The project type
 * @param {string[]} baseFlags - The base flags to transform
 * @returns {string[]} - Array of project-specific flags
 */
function generateProjectFlags(projectType, baseFlags) {
    const flags = [...baseFlags];

    if (projectType === 'mql4') {
        // Replace -D__MQL5__ with -D__MQL4__
        const mql5Index = flags.indexOf('-D__MQL5__');
        if (mql5Index !== -1) {
            flags[mql5Index] = '-D__MQL4__';
        }
        // Add MQL4-specific build flag
        flags.push('-D__MQL4_BUILD__');
    } else if (projectType === 'mql5') {
        // Add MQL5-specific build flag
        flags.push('-D__MQL5_BUILD__');
    }

    return flags;
}

/**
 * Detects the MQL version based on folder path and/or file extension.
 * Priority: file extension > folder path.
 * @param {string} folderPath - The folder path to check (optional)
 * @param {string} fileName - The file name to check (optional)
 * @returns {'mql4' | 'mql5' | null} - The detected MQL version or null if not determinable
 */
function detectMqlVersion(folderPath, fileName) {
    // Check file extension first (higher priority)
    if (fileName) {
        const ext = fileName.toLowerCase();
        if (ext.endsWith('.mq4')) {
            return 'mql4';
        }
        if (ext.endsWith('.mq5')) {
            return 'mql5';
        }
    }

    // Check folder path
    if (folderPath) {
        const upperPath = folderPath.toUpperCase();
        if (upperPath.includes('MQL4')) {
            return 'mql4';
        }
        if (upperPath.includes('MQL5')) {
            return 'mql5';
        }
    }

    // Default to mql5 if we have a path but can't determine version
    if (folderPath || fileName) {
        return 'mql5';
    }

    return null;
}

/**
 * Merges new flags into existing ones, avoiding duplicates and empty strings.
 * @param {string[]} currentFlags 
 * @param {string[]} newFlags 
 */
function mergeFlags(currentFlags, newFlags) {
    const combined = Array.isArray(currentFlags) ? [...currentFlags] : [];
    const sanitizedNew = newFlags.filter(f => f && typeof f === 'string' && f.trim().length > 0);
    for (const flag of sanitizedNew) {
        if (!combined.includes(flag)) {
            combined.push(flag);
        }
    }
    return combined;
}

/**
 * Safely updates VS Code configuration to avoid errors if settings are not registered.
 * @param {string} section - The configuration section to update
 * @param {any} value - The value to set
 * @param {vscode.ConfigurationTarget} target - The configuration target
 * @param {boolean} [silent=false] - If true, don't log anything on failure
 */
async function safeConfigUpdate(section, value, target, silent = false) {
    const config = vscode.workspace.getConfiguration();
    const info = config.inspect(section);

    // Check if the setting is actually registered by verifying at least one value exists
    // config.inspect() returns an object even for unknown settings, but all values will be undefined
    const isRegistered = info && (
        info.defaultValue !== undefined ||
        info.globalValue !== undefined ||
        info.workspaceValue !== undefined ||
        info.workspaceFolderValue !== undefined ||
        info.defaultLanguageValue !== undefined ||
        info.globalLanguageValue !== undefined ||
        info.workspaceLanguageValue !== undefined ||
        info.workspaceFolderLanguageValue !== undefined
    );

    if (!isRegistered) {
        if (!silent) {
            console.info(`MQL Tools: Optional setting "${section}" not available (extension may not be installed)`);
        }
        return;
    }

    try {
        await config.update(section, value, target);
    } catch (e) {
        if (!silent) {
            console.error(`MQL Tools: Failed to update "${section}": ${e.message}`);
        }
    }
}

/**
 * Parses an existing .clangd file and extracts diagnostic suppressions.
 * @param {string} clangdFilePath - Path to the .clangd file
 * @returns {Promise<string[]>} - Array of existing suppressions (empty if file doesn't exist or has no suppressions)
 */
async function parseClangdSuppressions(clangdFilePath) {
    try {
        const content = await fs.promises.readFile(clangdFilePath, 'utf8');
        const suppressions = [];
        let inDiagnostics = false;
        let inSuppress = false;

        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Diagnostics:')) {
                inDiagnostics = true;
                continue;
            }
            if (inDiagnostics && trimmed.startsWith('Suppress:')) {
                inSuppress = true;
                continue;
            }
            if (inDiagnostics && trimmed.startsWith('ClangTidy:')) {
                inSuppress = false;
                break;
            }
            if (inSuppress && trimmed.startsWith('- ')) {
                const suppression = trimmed.substring(2).trim();
                if (suppression && !suppression.startsWith('#')) {
                    suppressions.push(suppression);
                }
            }
        }

        return suppressions;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        console.error('MQL Tools: Failed to parse .clangd suppressions', err);
        return [];
    }
}

/**
 * Merges extension-provided suppressions with custom suppressions from file.
 * @param {string[]} newSuppressions - Suppressions provided by the extension
 * @param {string[]} existingSuppressions - Suppressions found in the existing .clangd file
 * @returns {string[]} - Merged suppressions without duplicates
 */
function mergeClangdSuppressions(newSuppressions, existingSuppressions) {
    const newSet = new Set(newSuppressions);
    const merged = [...newSuppressions];

    for (const suppression of existingSuppressions) {
        if (suppression && !newSet.has(suppression)) {
            merged.push(suppression);
            newSet.add(suppression);
        }
    }

    return merged;
}

/**
 * Main function to generate/update workspace properties for clangd.
 * @param {boolean} [force=false] - If true, force overwrite of existing config files
 */
async function CreateProperties(force = false) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
    }

    const config = vscode.workspace.getConfiguration();
    const configMql = vscode.workspace.getConfiguration('mql_tools');

    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
        ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
        : vscode.workspace.workspaceFolders[0];

    const workspacepath = workspaceFolder.uri.fsPath;
    const workspaceName = workspaceFolder.name;
    const incPath = pathModule.join(workspacepath, 'Include');

    // Path to MQL compatibility header for clangd
    const extensionPath = pathModule.join(__dirname, '..');
    const compatHeaderPath = normalizePath(pathModule.join(extensionPath, 'files', 'mql_clangd_compat.h'));

    // Base flags for clangd to improve MQL support.
    const baseFlags = [
        '-xc++',
        '-std=c++17',
        '-D__MQL__',
        '-D__MQL5__',
        `-include${compatHeaderPath}`,
        '-fms-extensions',           // Allow some non-standard C++ (like incomplete arrays)
        '-fms-compatibility',
        '-ferror-limit=0',           // Don't stop at 20 errors
        '-Wno-invalid-token-paste',
        '-Wno-unused-value',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',     // Silences string literal to char* warnings
        '-Xclang', '-Wno-invalid-pp-directive', // Force silence #property errors
        '-Wno-unknown-directives',
        '-Wno-language-extension-token',
        `-I${normalizePath(workspacepath)}`,
        `-I${normalizePath(incPath)}`
    ];

    let incDir;
    if (workspaceName.toUpperCase().includes('MQL4') || workspacepath.toUpperCase().includes('MQL4')) {
        incDir = configMql.Metaeditor.Include4Dir;
    } else {
        incDir = configMql.Metaeditor.Include5Dir;
    }

    // Allow ${workspaceFolder} and relative paths in settings.
    incDir = resolvePathRelativeToWorkspace(incDir, workspacepath);

    const arrPath = [...baseFlags];
    if (incDir && incDir.length > 0) {
        const externalIncDir = pathModule.join(incDir, 'Include');
        if (fs.existsSync(externalIncDir)) {
            arrPath.push(`-I${normalizePath(externalIncDir)}`);
        } else if (fs.existsSync(incDir)) {
            arrPath.push(`-I${normalizePath(incDir)}`);
        }
    }


    // Update fallback flags
    const existingFlags = config.get('clangd.fallbackFlags') || [];
    const mergedFlags = mergeFlags(existingFlags, arrPath);
    await safeConfigUpdate('clangd.fallbackFlags', mergedFlags, vscode.ConfigurationTarget.Workspace);
    // C_Cpp.intelliSenseEngine is optional - silent mode since C++ extension may not be installed
    await safeConfigUpdate('C_Cpp.intelliSenseEngine', 'Disabled', vscode.ConfigurationTarget.Workspace, true);

    // --- Generate compile_commands.json ---
    try {
        const targetFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5,mqh}'));
        const compileCommands = targetFiles.map(fileUri => {
            const filePath = normalizePath(fileUri.fsPath);
            const ext = pathModule.extname(filePath).toLowerCase();

            // Build arguments with MQL4/MQL5 specific defines
            const args = ['clang++'];
            arrPath.forEach(flag => {
                if (flag) {
                    // Replace __MQL5__ with __MQL4__ for .mq4 files
                    if (ext === '.mq4' && flag === '-D__MQL5__') {
                        args.push('-D__MQL4__');
                    } else {
                        args.push(flag);
                    }
                }
            });

            // Add file-specific defines
            if (ext === '.mq4') {
                args.push('-D__MQL4_BUILD__');
            } else if (ext === '.mq5') {
                args.push('-D__MQL5_BUILD__');
            }

            args.push(filePath);

            return {
                directory: normalizePath(workspacepath),
                arguments: args,
                file: filePath
            };
        });

        if (compileCommands.length > 0) {
            const dbPath = pathModule.join(workspacepath, 'compile_commands.json');
            await fs.promises.writeFile(dbPath, JSON.stringify(compileCommands, null, 4), 'utf8');

            // Cleanup conflicting files
            const legacyFlags = pathModule.join(workspacepath, 'compile_flags.txt');
            if (fs.existsSync(legacyFlags)) {
                await fs.promises.unlink(legacyFlags).catch(() => { });
            }
        }
    } catch (err) {
        console.error('MQL Tools: Failed to generate compile_commands.json', err);
    }

    const associations = { '*.mqh': 'cpp', '*.mq4': 'cpp', '*.mq5': 'cpp' };
    await safeConfigUpdate('mql_tools.context', true, vscode.ConfigurationTarget.Workspace);
    await safeConfigUpdate('files.associations', associations, vscode.ConfigurationTarget.Workspace);

    // --- Generate .clangd file for direct diagnostic suppression ---
    try {
        const clangdConfigPath = pathModule.join(workspacepath, '.clangd');
        const preserveSetting = configMql.Clangd?.PreserveSuppressions || 'prompt';
        let shouldPreserve = false;

        if (!force) {
            if (preserveSetting === 'always') {
                shouldPreserve = true;
            } else if (preserveSetting === 'never') {
                shouldPreserve = false;
            } else {
                const existingFile = fs.existsSync(clangdConfigPath);
                if (existingFile) {
                    const choice = await vscode.window.showWarningMessage(
                        'An existing .clangd file was found. Do you want to preserve your custom diagnostic suppressions?',
                        'Merge Suppressions',
                        'Overwrite'
                    );
                    shouldPreserve = choice === 'Merge Suppressions';
                }
            }
        }

        const baseSuppressions = [
            'pp_file_not_found',
            'err_pp_file_not_found',
            'err_cannot_open_file',
            'unsupported_encoding',
            'unsupported_bom',
            'bad_cxx_cast_generic',
            'lexing_error',
            'character_too_large',
            'pp_invalid_directive',
            'unknown_directive',
            'pp_import_directive_ms',
            'typecheck_incomplete_array_needs_initializer',
            'illegal_decl_array_of_references',
            'typecheck_subscript_not_integer',
            'flexible_array_not_at_end',
            'typecheck_invalid_operands',
            'typecheck_convert_incompatible_pointer',
            'typecheck_invalid_lvalue_addrof',
            'increment_decrement_enum',
            'init_conversion_failed',
            'reference_bind_drops_quals',
            'lvalue_reference_bind_to_temporary',
            'err_lvalue_reference_bind_to_unrelated',
            'ovl_no_conversion_in_cast',
            'ovl_no_viable_conversion_in_cast',
            'ovl_no_viable_function_in_call',
            'ovl_no_viable_function_in_init',
            'ovl_no_viable_member_function_in_call',
            'ovl_diff_return_type',
            'ovl_ambiguous_call',
            'ovl_ambiguous_conversion',
            'ovl_ambiguous_conversion_in_cast',
            'ovl_ambiguous_oper_binary',
            'ovl_ambiguous_oper_unary',
            'ambig_derived_to_base_conv',
            'ovl_deleted_special_init',
            'ovl_no_viable_subscript',
            'error_subscript_overload',
            'missing_default_ctor',
            'ctor_conv_to_void_ptr',
            'member_init_from_this',
            'mem_init_not_member_or_class',
            'uninitialized_member_in_ctor',
            'access_dtor',
            'allocation_of_abstract_type',
            'incomplete_base_class',
            'function_marked_override_not_overriding',
            'undeclared_var_use',
            'undeclared_var_use_suggest',
            'redefinition',
            'param_default_argument_redefinition',
            'bad_parameter_name_template_id',
            'non-pod-varargs',
            'duplicate_case',
            'writable-strings',
            'conditional_ambiguous',
            'err_typecheck_member_reference_suggestion',
            'invalid_non_static_member_use',
            'err_field_incomplete_or_sizeless',
            'new_incomplete_or_sizeless_type',
            'sizeof_alignof_incomplete_or_sizeless_type',
            'err_typecheck_bool_condition',
            'err_typecheck_ambiguous_condition',
            'tautological-constant-out-of-range-compare',
            'unknown_typename',
            'no_template',
            'no_template_suggest',
            'unknown_type_or_class_name_suggest',
            'ref_non_value',
            'expected_lparen_after_type',
            'invalid_token_after_toplevel_declarator',
            'expected_unqualified_id',
            'unexpected_unqualified_id',
            'expected_param_declarator',
            'missing_param',
            'expected_type',
            'typename_requires_specqual',
            'unexpected_typedef',
            'expected_class_name',
            'template_missing_args',
            'member_with_template_arguments',
            'missing_type_specifier',
            'expected_semi_decl_list',
            'member_redeclared',
            'expected_after',
            'extraneous_closing_brace',
            'expected_qualified_after_typename',
            'override_keyword_only_allowed_on_virtual_member_functions',
            'auto_not_allowed',
            'invalid_decl_spec_combination',
            'expected_fn_body',
            'typename_nested_not_found',
            'member_function_call_bad_type',
            'member_call_without_object',
            'typecheck_unary_expr',
            'typecheck_convert_incompatible',
            'typecheck_member_reference_struct_union',
            'typecheck_nonviable_condition',
            'typecheck_call_too_many_args_at_most',
            'typecheck_call_too_many_args_suggest',
            'typecheck_call_too_few_args_at_least',
            'typecheck_call_too_few_args_suggest',
            'base_class_has_flexible_array_member',
            'flexible_array_has_nontrivial_dtor',
            'unknown_typename_suggest',
            'impcast_complex_scalar',
            'ovl_no_viable_oper',
            'ovl_ambiguous_member_call',
            'typecheck_subscript_value',
            'ovl_ambiguous_init',
            'reference_bind_failed',
            'typecheck_call_too_many_args',
            'typecheck_call_too_few_args_at_least_one',
            'excess_initializers',
            'typecheck_expression_not_modifiable_lvalue',
            'incomplete_member_access',
            'incomplete_type',
            'typecheck_incomplete_tag',
            'constructor_return_type',
            'destructor_return_type',
            'pp_including_mainfile_in_preamble',
            'pp_include_too_deep',
            'expected_expression',
            'constructor_redeclared',
            'bound_member_function',
            'static_out_of_line',
            'no_member_suggest',
            'no_member',
            'expected',
            'err_member_reference_needs_call',
            'member_reference_needs_call',
            'expected_arrow_after_this',
            'err_expected_arrow_after_this',
            'extraneous_token_before_semi',
            'expected_semi_after_expr'
        ];

        let finalSuppressions = baseSuppressions;
        if (shouldPreserve && fs.existsSync(clangdConfigPath)) {
            const existingSuppressions = await parseClangdSuppressions(clangdConfigPath);
            finalSuppressions = mergeClangdSuppressions(baseSuppressions, existingSuppressions);
        }

        const suppressionsYaml = finalSuppressions.map(s => `    - ${s}`).join('\n');

        const clangdConfig =
            `# MQL Clangd Configuration
# Auto-generated by MQL Clangd extension
# This file suppresses false-positive errors from clangd for MQL-specific syntax
#
# ============================================================================
# TO SUPPRESS ADDITIONAL WARNINGS:
# Add warning flags to the Suppress list below. Examples:
#   - -Wparentheses          # "Possible assignment in condition"
#   - -Wunused-variable      # Unused variable warnings
#   - -Wunused-parameter     # Unused parameter warnings
#
# Or use inline pragmas in your code:
#   #pragma clang diagnostic ignored "-Wparentheses"
# ============================================================================

Diagnostics:
  Suppress:
${suppressionsYaml}

  ClangTidy:
    Remove:
      - modernize-*
      - cppcoreguidelines-*
      - readability-identifier-naming
      - bugprone-narrowing-conversions
      - cert-*
      - hicpp-*
      - performance-*
      - google-*
    
Hover:
    ShowAKA: No

CompileFlags:
  Add:
    # Suppress all warnings in .clangd config; targeted -Wno-* flags are already set in baseFlags
    - -Wno-everything

InlayHints:
  Enabled: Yes
  ParameterNames: Yes
  DeducedTypes: Yes
`;
        await fs.promises.writeFile(clangdConfigPath, clangdConfig, 'utf8');
    } catch (err) {
        console.error('MQL Tools: Failed to generate .clangd', err);
    }

    // --- Generate .clang-format file for MQL-friendly formatting ---
    try {
        const clangFormatPath = pathModule.join(workspacepath, '.clang-format');
        const clangFormatMarker = '# MQL Clang-Format Configuration (generated)';
        const clangFormatConfig =
            `# MQL Clang-Format Configuration (generated)
# Auto-generated by MQL Clangd extension
# Prevents clang-format from breaking MQL-specific syntax like #property directives

BasedOnStyle: LLVM
Language: Cpp

# Indentation
IndentWidth: 4
TabWidth: 4
UseTab: Never

# Line length - reasonable for MQL code
ColumnLimit: 0

# Preprocessor formatting - CRITICAL for MQL #property directives
# Setting to None prevents clang-format from adding backslash line continuations
IndentPPDirectives: None

# Keep original line breaks where possible
BreakBeforeBraces: Attach
AllowShortFunctionsOnASingleLine: None
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false

# Pointer and reference alignment
PointerAlignment: Left
ReferenceAlignment: Left

# Spacing
SpaceAfterCStyleCast: false
SpaceBeforeParens: ControlStatements
SpacesInParentheses: false

# Include sorting - disabled to preserve MQL include order
SortIncludes: Never
`;

        // Check if file exists and preserve user config
        try {
            await fs.promises.access(clangFormatPath);
            // File exists, read it to check for MQL marker
            const existingConfig = await fs.promises.readFile(clangFormatPath, 'utf8');

            // Only overwrite if the file contains our marker or force flag is set
            if (existingConfig.includes(clangFormatMarker) || force) {
                await fs.promises.writeFile(clangFormatPath, clangFormatConfig, 'utf8');
                console.log('MQL Tools: .clang-format file updated');
            } else {
                console.log('MQL Tools: Preserving existing user .clang-format configuration');
            }
        } catch (accessErr) {
            // File doesn't exist, create it
            if (accessErr.code === 'ENOENT') {
                await fs.promises.writeFile(clangFormatPath, clangFormatConfig, 'utf8');
                console.log('MQL Tools: .clang-format file created');
            } else {
                throw accessErr;
            }
        }
    } catch (err) {
        console.error('MQL Tools: Failed to generate .clang-format', err);
    }
}

/**
 * Secondary helper to update properties during compilation.
 */
function Cpp_prop(incDir) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;

    const config = vscode.workspace.getConfiguration();
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
        ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
        : vscode.workspace.workspaceFolders[0];

    const workspacepath = workspaceFolder.uri.fsPath;
    const incPath = pathModule.join(workspacepath, 'Include');

    // Allow ${workspaceFolder} and relative paths in settings.
    const resolvedIncDir = resolvePathRelativeToWorkspace(incDir, workspacepath);

    const extensionPath = pathModule.join(__dirname, '..');
    const compatHeaderPath = normalizePath(pathModule.join(extensionPath, 'files', 'mql_clangd_compat.h'));

    const baseFlags = [
        '-xc++',
        '-std=c++17',
        `-include${compatHeaderPath}`,
        '-fms-extensions',
        '-fms-compatibility',
        '-ferror-limit=0',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',
        '-Xclang', '-Wno-invalid-pp-directive',
        '-Wno-unknown-directives',
        `-I${normalizePath(workspacepath)}`,
        `-I${normalizePath(incPath)}`
    ];

    // If user already points to an Include folder, don't append Include/Include.
    // Only add an -I flag if we have a non-empty, valid include directory.
    let arrPath = baseFlags;
    if (resolvedIncDir && typeof resolvedIncDir === 'string' && resolvedIncDir.length > 0) {
        const includeCandidate = pathModule.join(resolvedIncDir, 'Include');
        const includeDirForFlags = (fs.existsSync(includeCandidate)) ? includeCandidate : resolvedIncDir;
        const normalizedIncDir = normalizePath(includeDirForFlags);
        if (normalizedIncDir && normalizedIncDir.length > 0) {
            arrPath = [...baseFlags, `-I${normalizedIncDir}`];
        }
    }

    const existingFlags = config.get('clangd.fallbackFlags') || [];
    const mergedFlags = mergeFlags(existingFlags, arrPath);
    safeConfigUpdate('clangd.fallbackFlags', mergedFlags, vscode.ConfigurationTarget.Workspace);
    // C_Cpp.intelliSenseEngine is optional - silent mode since C++ extension may not be installed
    safeConfigUpdate('C_Cpp.intelliSenseEngine', 'Disabled', vscode.ConfigurationTarget.Workspace, true);
}

module.exports = {
    CreateProperties,
    Cpp_prop,
    normalizePath,
    expandWorkspaceVariables,
    resolvePathRelativeToWorkspace,
    isSourceExtension,
    detectMqlVersion,
    generateIncludeFlag,
    generateBaseFlags,
    generateProjectFlags,
    generatePortableSwitch,
    parseClangdSuppressions,
    mergeClangdSuppressions,
    safeConfigUpdate
};
