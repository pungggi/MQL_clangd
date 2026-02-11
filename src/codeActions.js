'use strict';

const vscode = require('vscode');
const { findClosestMatches } = require('./spellcheck');

/**
 * Code Action provider for MQL errors - offers quick fixes
 */
class MqlCodeActionProvider {
    provideCodeActions(document, _range, context) {
        const actions = [];

        for (const diagnostic of context.diagnostics) {
            const errorCode = diagnostic.code?.value; // e.g., "MQL199"
            const msg = diagnostic.message || '';



            // Handle clangd's "unknown type name 'XXX'" error
            const typeMatch = msg.match(/unknown type name '(\w+)'/i);
            if (typeMatch) {
                const typeName = typeMatch[1];
                const insertIncludeAction = new vscode.CodeAction(
                    `Add #ifdef __clang__ include for '${typeName}'`,
                    vscode.CodeActionKind.QuickFix
                );
                insertIncludeAction.edit = new vscode.WorkspaceEdit();
                const includeText = `#ifdef __clang__\n#include <${typeName}.mqh>  // TODO: Adjust path if needed\n#endif\n\n`;
                insertIncludeAction.edit.insert(document.uri, new vscode.Position(0, 0), includeText);
                insertIncludeAction.diagnostics = [diagnostic];
                actions.push(insertIncludeAction);
                continue;
            }

            // Phase 1A: Handle "wrong parameters count" error (MQL199)
            if (errorCode === 'MQL199' || diagnostic.message.includes('wrong parameters count')) {
                const funcMatch = diagnostic.message.match(/'(\w+)'/);
                if (funcMatch) {
                    const funcName = funcMatch[1];
                    const docsAction = this._createOpenDocsAction(funcName, diagnostic);
                    if (docsAction) actions.push(docsAction);
                }
            }

            // Phase 1B: Handle MQL "undeclared identifier" error (MQL256)
            if (errorCode === 'MQL256' || diagnostic.message.toLowerCase().includes('undeclared identifier')) {
                const identifierActions = this._createDeclareVariableActions(document, diagnostic);
                actions.push(...identifierActions);
            }

            // Spelling fix: Handle clangd's "use of undeclared identifier" for misspelled functions
            // clangd formats: "use of undeclared identifier 'X'" or "unknown identifier 'X'"
            // Also catches: "call to undeclared function", "undeclared identifier"
            const msgLower = msg.toLowerCase();
            if (msgLower.includes('undeclared') ||
                msgLower.includes('unknown') && msgLower.includes('identifier') ||
                msgLower.includes('not declared') ||
                msgLower.includes('was not declared')) {
                const spellingActions = this._createSpellingFixActions(document, diagnostic);
                // Add spelling fixes at the beginning for visibility
                actions.unshift(...spellingActions);
            }

            // Phase 1C: Handle "missing return" errors (MQL117, MQL121)
            if (errorCode === 'MQL117' || errorCode === 'MQL121' ||
                diagnostic.message.toLowerCase().includes('return')) {
                const returnAction = this._createAddReturnAction(document, diagnostic);
                if (returnAction) actions.push(returnAction);
            }

            // Phase 2: Handle "missing entry point" errors (MQL209, MQL356)
            if (errorCode === 'MQL209' || errorCode === 'MQL356') {
                const entryPointActions = this._createEntryPointActions(document, diagnostic, errorCode);
                actions.push(...entryPointActions);
            }

            // Phase 3: Handle "cannot convert to enum" error (MQL262)
            if (errorCode === 'MQL262' || diagnostic.message.toLowerCase().includes('cannot convert')) {
                const enumActions = this._createEnumSuggestionActions(document, diagnostic);
                actions.push(...enumActions);
            }

            // Phase 4: Handle "implicit conversion from 'number' to 'string'" warning (MQL181)
            if (errorCode === 'MQL181' && diagnostic.message.includes("implicit conversion from 'number' to 'string'")) {
                const conversionActions = this._createStringConversionActions(document, diagnostic);
                actions.push(...conversionActions);
            }

        }

        return actions;
    }

    /**
     * Phase 1A: Create action to open documentation for a function
     *
     * QuickFix Title Pattern: "MQL: Open documentation for '<function>'"
     * - Machine-recognizable prefix: "MQL: Open documentation for"
     * - Action: Opens MQL5 documentation for the specified function
     * - Safe: Yes (read-only, opens browser)
     */
    _createOpenDocsAction(funcName, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Open documentation for '${funcName}'`,
            vscode.CodeActionKind.QuickFix
        );

        // Use command to trigger Help system with the function name
        action.command = {
            command: 'mql_tools.help',
            title: 'Open documentation',
            arguments: [funcName, 5]  // Pass function name and default to MQL5
        };

        action.diagnostics = [diagnostic];
        action.isPreferred = true; // Show first in quickfix list

        return action;
    }

    /**
     * Phase 1B: Create quick fix actions to declare an undeclared variable
     */
    _createDeclareVariableActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const col = diagnostic.range.start.character;

        // Extract the identifier name from the document at the error position
        const lineText = document.lineAt(line).text;
        const identifierMatch = lineText.substring(col).match(/^(\w+)/);
        if (!identifierMatch) return actions;

        const identifier = identifierMatch[1];

        // Add input parameter option first (most common for EAs/indicators)
        const inputAction = this._createInputDeclarationAction(document, identifier, diagnostic);
        if (inputAction) {
            actions.push(inputAction);
        }

        // Then add local variable options
        // QuickFix Title Pattern: "MQL: Declare '<identifier>' as local <type>"
        // - Machine-recognizable prefix: "MQL: Declare"
        // - Action: Inserts local variable declaration
        // - Safe: Yes (adds code, does not modify existing)
        const commonTypes = ['int', 'double', 'string', 'bool', 'color', 'datetime', 'long'];

        // Find the start of the current function/block to insert declaration
        const funcStart = this._findFunctionStart(document, line);

        for (const type of commonTypes) {
            const action = new vscode.CodeAction(
                `MQL: Declare '${identifier}' as local ${type}`,
                vscode.CodeActionKind.QuickFix
            );
            action.edit = new vscode.WorkspaceEdit();

            if (funcStart !== null) {
                // Insert at start of function body
                const insertLine = funcStart.line + 1;
                const indent = this._getIndent(document, insertLine);
                action.edit.insert(
                    document.uri,
                    new vscode.Position(insertLine, 0),
                    `${indent}${type} ${identifier};\n`
                );
            } else {
                // Insert on the line before the error
                const indent = this._getIndent(document, line);
                action.edit.insert(
                    document.uri,
                    new vscode.Position(line, 0),
                    `${indent}${type} ${identifier};\n`
                );
            }

            action.diagnostics = [diagnostic];
            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 1B: Create action to declare as input parameter
     *
     * QuickFix Title Pattern: "MQL: Declare '<identifier>' as input parameter"
     * - Machine-recognizable prefix: "MQL: Declare"
     * - Action: Inserts input parameter declaration at file header
     * - Safe: Yes (adds code, does not modify existing)
     */
    _createInputDeclarationAction(document, identifier, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Declare '${identifier}' as input parameter`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Find position to insert (after existing inputs or at top)
        const insertPos = this._findInputInsertPosition(document);

        // Guess type based on identifier name
        const type = this._guessInputType(identifier);
        const defaultValue = this._getDefaultValue(type);

        const inputLine = `input ${type} ${identifier} = ${defaultValue};  // TODO: Adjust type and default\n`;

        action.edit.insert(document.uri, insertPos, inputLine);
        action.diagnostics = [diagnostic];
        action.isPreferred = true; // Prefer input declaration for EAs

        return action;
    }

    /**
     * Find the opening brace of the containing function
     */
    _findFunctionStart(document, fromLine) {
        let braceCount = 0;
        for (let i = fromLine; i >= 0; i--) {
            const text = document.lineAt(i).text;
            for (let j = text.length - 1; j >= 0; j--) {
                if (text[j] === '}') braceCount++;
                if (text[j] === '{') {
                    if (braceCount === 0) {
                        return { line: i, character: j };
                    }
                    braceCount--;
                }
            }
        }
        return null;
    }

    /**
     * Get the indentation of a line
     */
    _getIndent(document, lineNum) {
        if (lineNum >= document.lineCount) return '    ';
        const lineText = document.lineAt(lineNum).text;
        const match = lineText.match(/^(\s*)/);
        return match ? match[1] : '    ';
    }

    /**
     * Phase 1B: Find best position to insert input declaration
     */
    _findInputInsertPosition(document) {
        // Look for existing input declarations
        for (let i = 0; i < Math.min(50, document.lineCount); i++) {
            const line = document.lineAt(i).text;
            if (line.match(/^\s*input\s+/)) {
                // Found existing input, insert after last one
                let lastInputLine = i;
                for (let j = i + 1; j < Math.min(100, document.lineCount); j++) {
                    if (document.lineAt(j).text.match(/^\s*input\s+/)) {
                        lastInputLine = j;
                    } else if (document.lineAt(j).text.trim() &&
                        !document.lineAt(j).text.trim().startsWith('//')) {
                        break;
                    }
                }
                return new vscode.Position(lastInputLine + 1, 0);
            }
        }

        // No existing inputs, insert after #property lines or at top
        for (let i = 0; i < Math.min(20, document.lineCount); i++) {
            const line = document.lineAt(i).text;
            if (!line.trim().startsWith('#') && !line.trim().startsWith('//') && line.trim()) {
                return new vscode.Position(i, 0);
            }
        }

        return new vscode.Position(0, 0);
    }

    /**
     * Phase 1B: Guess input type from identifier name
     */
    _guessInputType(identifier) {
        const lower = identifier.toLowerCase();
        if (lower.includes('lot') || lower.includes('volume')) return 'double';
        if (lower.includes('magic') || lower.includes('period') || lower.includes('shift')) return 'int';
        if (lower.includes('enable') || lower.includes('use') || lower.includes('show')) return 'bool';
        if (lower.includes('comment') || lower.includes('symbol')) return 'string';
        if (lower.includes('color') || lower.includes('clr')) return 'color';
        return 'double'; // Default
    }

    /**
     * Phase 1B: Get default value for type
     */
    _getDefaultValue(type) {
        const defaults = {
            'int': '0',
            'double': '0.1',
            'bool': 'true',
            'string': '""',
            'color': 'clrRed',
            'datetime': '0',
            'long': '0'
        };
        return defaults[type] || '0';
    }

    /**
     * Phase 1C: Create action to add default return statement
     *
     * QuickFix Title Pattern: "MQL: Add return statement '<value>'"
     * - Machine-recognizable prefix: "MQL: Add return statement"
     * - Action: Inserts return statement at end of function
     * - Safe: Yes (adds code at function end)
     */
    _createAddReturnAction(document, diagnostic) {
        const line = diagnostic.range.start.line;

        // Find function signature to determine return type
        const returnType = this._findFunctionReturnType(document, line);
        if (!returnType || returnType === 'void') return null;

        const defaultValue = this._getReturnDefaultValue(returnType);

        const action = new vscode.CodeAction(
            `MQL: Add return statement '${defaultValue}'`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Find closing brace of function
        const closingBrace = this._findFunctionClosingBrace(document, line);
        if (closingBrace) {
            const indent = this._getIndent(document, closingBrace.line);
            action.edit.insert(
                document.uri,
                new vscode.Position(closingBrace.line, 0),
                `${indent}return ${defaultValue};\n`
            );
        }

        action.diagnostics = [diagnostic];
        return action;
    }

    /**
     * Phase 1C: Find function return type
     */
    _findFunctionReturnType(document, fromLine) {
        // Search backwards for function signature
        for (let i = fromLine; i >= Math.max(0, fromLine - 50); i--) {
            const line = document.lineAt(i).text;
            // Match function signature: returnType functionName(...)
            const match = line.match(/^\s*(int|double|bool|string|long|ulong|datetime|color|void)\s+\w+\s*\(/);
            if (match) {
                return match[1];
            }
        }
        return null;
    }

    /**
     * Phase 1C: Get default return value for type
     */
    _getReturnDefaultValue(type) {
        const defaults = {
            'int': '0',
            'double': '0.0',
            'bool': 'false',
            'string': '""',
            'long': '0',
            'ulong': '0',
            'datetime': '0',
            'color': 'clrNONE'
        };
        return defaults[type] || '0';
    }

    /**
     * Phase 1C: Find closing brace of function
     */
    _findFunctionClosingBrace(document, fromLine) {
        let braceCount = 0;
        let foundStart = false;

        for (let i = fromLine; i < document.lineCount; i++) {
            const text = document.lineAt(i).text;
            for (let j = 0; j < text.length; j++) {
                if (text[j] === '{') {
                    braceCount++;
                    foundStart = true;
                }
                if (text[j] === '}') {
                    braceCount--;
                    if (foundStart && braceCount === 0) {
                        return { line: i, character: j };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Phase 2: Create entry point skeleton actions
     */
    _createEntryPointActions(document, diagnostic, errorCode) {
        const actions = [];

        // Determine file type and appropriate entry points
        if (errorCode === 'MQL209') {
            // Indicator missing OnCalculate
            const action = this._createInsertEntryPointAction(
                document,
                'OnCalculate',
                this._getOnCalculateTemplate(),
                diagnostic
            );
            if (action) actions.push(action);
        } else if (errorCode === 'MQL356') {
            // EA or Script missing entry point
            // Offer both OnTick (EA) and OnStart (Script)
            const onTickAction = this._createInsertEntryPointAction(
                document,
                'OnTick',
                this._getOnTickTemplate(),
                diagnostic
            );
            if (onTickAction) actions.push(onTickAction);

            const onStartAction = this._createInsertEntryPointAction(
                document,
                'OnStart',
                this._getOnStartTemplate(),
                diagnostic
            );
            if (onStartAction) actions.push(onStartAction);
        }

        return actions;
    }

    /**
     * Phase 2: Create action to insert entry point template
     *
     * QuickFix Title Pattern: "MQL: Insert entry point '<function>'"
     * - Machine-recognizable prefix: "MQL: Insert entry point"
     * - Action: Inserts complete function skeleton (OnCalculate/OnTick/OnStart)
     * - Safe: Yes (adds code at file end)
     */
    _createInsertEntryPointAction(document, entryPointName, template, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Insert entry point '${entryPointName}()'`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Insert at end of file
        const lastLine = document.lineCount;
        action.edit.insert(
            document.uri,
            new vscode.Position(lastLine, 0),
            `\n${template}\n`
        );

        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        return action;
    }

    /**
     * Phase 2: Get OnCalculate template for indicators
     */
    _getOnCalculateTemplate() {
        return `int OnCalculate(const int rates_total,
                const int prev_calculated,
                const int begin,
                const double &price[])
{
    // TODO: Implement indicator calculation

    return rates_total;
}`;
    }

    /**
     * Phase 2: Get OnTick template for EAs
     */
    _getOnTickTemplate() {
        return `void OnTick()
{
    // TODO: Implement trading logic

}`;
    }

    /**
     * Phase 2: Get OnStart template for scripts
     */
    _getOnStartTemplate() {
        return `void OnStart()
{
    // TODO: Implement script logic

}`;
    }

    /**
     * Phase 3: Create enum suggestion actions
     *
     * QuickFix Title Pattern: "MQL: Use enum '<ENUM_VALUE>' (<description>)"
     * - Machine-recognizable prefix: "MQL: Use enum"
     * - Action: Replaces numeric literal with proper MQL enum constant
     * - Safe: Yes (replaces value with equivalent enum)
     */
    _createEnumSuggestionActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const lineText = document.lineAt(line).text;

        // Try to find function call context
        const funcMatch = lineText.match(/(\w+)\s*\(/);
        if (!funcMatch) return actions;

        const funcName = funcMatch[1];

        // Get enum suggestions for this function
        const enumSuggestions = this._getEnumSuggestionsForFunction(funcName, lineText);

        for (const suggestion of enumSuggestions) {
            const action = new vscode.CodeAction(
                `MQL: Use enum '${suggestion.value}' (${suggestion.description})`,
                vscode.CodeActionKind.QuickFix
            );

            action.edit = new vscode.WorkspaceEdit();

            // Find the problematic parameter (usually a number like 0)
            const paramMatch = lineText.match(/,\s*(\d+)\s*[,)]/);
            if (paramMatch) {
                const startPos = lineText.indexOf(paramMatch[1], paramMatch.index);
                action.edit.replace(
                    document.uri,
                    new vscode.Range(
                        new vscode.Position(line, startPos),
                        new vscode.Position(line, startPos + paramMatch[1].length)
                    ),
                    suggestion.value
                );
            }

            action.diagnostics = [diagnostic];
            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 3: Get enum suggestions for specific functions
     *
     * ENUM_SUGGESTIONS Structure:
     * - Organized by function name for fast lookup
     * - Each function maps to array of { value, description, enumType, paramIndex }
     * - enumType: The MQL5 enum type (for documentation)
     * - paramIndex: 1-based parameter position in function signature
     * - Derived from files/mql_clangd_compat.h function signatures
     *
     * Machine-readable format for LLM agents:
     * - Consistent structure enables programmatic selection
     * - Description aids understanding without docs lookup
     * - enumType enables type-aware filtering
     */
    _getEnumSuggestionsForFunction(funcName) {
        // =================================================================
        // COMPREHENSIVE ENUM SUGGESTIONS MAPPING
        // Based on MQL5 function signatures from mql_clangd_compat.h
        // =================================================================

        /**
         * Shared enum value sets (reused across multiple functions)
         */
        const ENUM_TIMEFRAMES = [
            { value: 'PERIOD_CURRENT', description: 'Current chart timeframe', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M1', description: '1 minute', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M5', description: '5 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M15', description: '15 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M30', description: '30 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_H1', description: '1 hour', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_H4', description: '4 hours', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_D1', description: 'Daily', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_W1', description: 'Weekly', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_MN1', description: 'Monthly', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 }
        ];

        const ENUM_MA_METHOD = [
            { value: 'MODE_SMA', description: 'Simple Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_EMA', description: 'Exponential Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_SMMA', description: 'Smoothed Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_LWMA', description: 'Linear Weighted Moving Average', enumType: 'ENUM_MA_METHOD' }
        ];

        const ENUM_APPLIED_PRICE = [
            { value: 'PRICE_CLOSE', description: 'Close price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_OPEN', description: 'Open price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_HIGH', description: 'High price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_LOW', description: 'Low price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_MEDIAN', description: 'Median price (HL/2)', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_TYPICAL', description: 'Typical price (HLC/3)', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_WEIGHTED', description: 'Weighted price (HLCC/4)', enumType: 'ENUM_APPLIED_PRICE' }
        ];

        const ENUM_APPLIED_VOLUME = [
            { value: 'VOLUME_TICK', description: 'Tick volume', enumType: 'ENUM_APPLIED_VOLUME' },
            { value: 'VOLUME_REAL', description: 'Real volume', enumType: 'ENUM_APPLIED_VOLUME' }
        ];

        const ENUM_STO_PRICE = [
            { value: 'STO_LOWHIGH', description: 'Low/High prices', enumType: 'ENUM_STO_PRICE' },
            { value: 'STO_CLOSECLOSE', description: 'Close/Close prices', enumType: 'ENUM_STO_PRICE' }
        ];

        const ENUM_ORDER_TYPE = [
            { value: 'ORDER_TYPE_BUY', description: 'Market buy order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL', description: 'Market sell order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_BUY_LIMIT', description: 'Buy limit pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL_LIMIT', description: 'Sell limit pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_BUY_STOP', description: 'Buy stop pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL_STOP', description: 'Sell stop pending order', enumType: 'ENUM_ORDER_TYPE' }
        ];

        const ENUM_ORDER_FILLING = [
            { value: 'ORDER_FILLING_FOK', description: 'Fill or Kill - complete fill only', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_IOC', description: 'Immediate or Cancel - partial allowed', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_RETURN', description: 'Return - partial fills returned', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_BOC', description: 'Book or Cancel', enumType: 'ENUM_ORDER_TYPE_FILLING' }
        ];

        const ENUM_TRADE_REQUEST_ACTIONS = [
            { value: 'TRADE_ACTION_DEAL', description: 'Place market order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_PENDING', description: 'Place pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_SLTP', description: 'Modify SL/TP of position', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_MODIFY', description: 'Modify pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_REMOVE', description: 'Delete pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_CLOSE_BY', description: 'Close position by opposite', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' }
        ];

        // =================================================================
        // FUNCTION-SPECIFIC ENUM MAPPINGS
        // Signature: functionName(param1, param2, ...) - paramIndex is 1-based
        // =================================================================

        const ENUM_SUGGESTIONS = {
            // ---------------------------------------------------------------
            // INDICATOR FUNCTIONS (Technical Analysis)
            // ---------------------------------------------------------------

            // iMA(symbol, period, ma_period, ma_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iRSI(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iRSI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iMACD(symbol, period, fast_ema_period, slow_ema_period, signal_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iMACD': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iStochastic(symbol, period, Kperiod, Dperiod, slowing, ma_method, price_field)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_MA_METHOD, Param 7: ENUM_STO_PRICE
            'iStochastic': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 6 })),
                ...ENUM_STO_PRICE.map(e => ({ ...e, paramIndex: 7 }))
            ],

            // iBands(symbol, period, bands_period, bands_shift, deviation, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iBands': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iCCI(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iCCI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iMomentum(symbol, period, mom_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iMomentum': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iATR(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iATR': [...ENUM_TIMEFRAMES],

            // iADX(symbol, period, adx_period)
            // Param 2: ENUM_TIMEFRAMES
            'iADX': [...ENUM_TIMEFRAMES],

            // iMFI(symbol, period, ma_period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_VOLUME
            'iMFI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iOBV(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iOBV': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iVolumes(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iVolumes': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iAD(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iAD': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iForce(symbol, period, ma_period, ma_method, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_MA_METHOD, Param 5: ENUM_APPLIED_VOLUME
            'iForce': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 4 })),
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iChaikin(symbol, period, fast_ma_period, slow_ma_period, ma_method, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_VOLUME
            'iChaikin': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iEnvelopes(symbol, period, ma_period, ma_shift, ma_method, applied_price, deviation)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iEnvelopes': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iStdDev(symbol, period, ma_period, ma_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iStdDev': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iDEMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iDEMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iTEMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iTEMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iFrAMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iFrAMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iAMA(symbol, period, ama_period, fast_ma_period, slow_ma_period, ama_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 7: ENUM_APPLIED_PRICE
            'iAMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 7 }))
            ],

            // iVIDyA(symbol, period, cmo_period, ema_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iVIDyA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iTriX(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iTriX': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iOsMA(symbol, period, fast_ema_period, slow_ema_period, signal_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iOsMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iWPR(symbol, period, calc_period)
            // Param 2: ENUM_TIMEFRAMES
            'iWPR': [...ENUM_TIMEFRAMES],

            // iSAR(symbol, period, step, maximum)
            // Param 2: ENUM_TIMEFRAMES
            'iSAR': [...ENUM_TIMEFRAMES],

            // iRVI(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iRVI': [...ENUM_TIMEFRAMES],

            // iDeMarker(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iDeMarker': [...ENUM_TIMEFRAMES],

            // iFractals(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iFractals': [...ENUM_TIMEFRAMES],

            // iAC(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iAC': [...ENUM_TIMEFRAMES],

            // iAO(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iAO': [...ENUM_TIMEFRAMES],

            // iBWMFI(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iBWMFI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iBearsPower(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iBearsPower': [...ENUM_TIMEFRAMES],

            // iBullsPower(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iBullsPower': [...ENUM_TIMEFRAMES],

            // iAlligator(symbol, period, jaw_period, jaw_shift, teeth_period, teeth_shift, lips_period, lips_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 9: ENUM_MA_METHOD, Param 10: ENUM_APPLIED_PRICE
            'iAlligator': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 9 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 10 }))
            ],

            // iGator(symbol, period, jaw_period, jaw_shift, teeth_period, teeth_shift, lips_period, lips_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 9: ENUM_MA_METHOD, Param 10: ENUM_APPLIED_PRICE
            'iGator': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 9 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 10 }))
            ],

            // iIchimoku(symbol, period, tenkan_sen, kijun_sen, senkou_span_b)
            // Param 2: ENUM_TIMEFRAMES
            'iIchimoku': [...ENUM_TIMEFRAMES],

            // ---------------------------------------------------------------
            // TIMESERIES / DATA COPY FUNCTIONS
            // ---------------------------------------------------------------

            // CopyRates(symbol, timeframe, start_pos, count, rates_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyRates': [...ENUM_TIMEFRAMES],

            // CopyTime(symbol, timeframe, start_pos, count, time_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyTime': [...ENUM_TIMEFRAMES],

            // CopyOpen(symbol, timeframe, start_pos, count, open_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyOpen': [...ENUM_TIMEFRAMES],

            // CopyHigh(symbol, timeframe, start_pos, count, high_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyHigh': [...ENUM_TIMEFRAMES],

            // CopyLow(symbol, timeframe, start_pos, count, low_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyLow': [...ENUM_TIMEFRAMES],

            // CopyClose(symbol, timeframe, start_pos, count, close_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyClose': [...ENUM_TIMEFRAMES],

            // CopyTickVolume(symbol, timeframe, start_pos, count, volume_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyTickVolume': [...ENUM_TIMEFRAMES],

            // CopyRealVolume(symbol, timeframe, start_pos, count, volume_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyRealVolume': [...ENUM_TIMEFRAMES],

            // CopySpread(symbol, timeframe, start_pos, count, spread_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopySpread': [...ENUM_TIMEFRAMES],

            // iBars(symbol, timeframe)
            // Param 2: ENUM_TIMEFRAMES
            'iBars': [...ENUM_TIMEFRAMES],

            // iBarShift(symbol, timeframe, time, exact)
            // Param 2: ENUM_TIMEFRAMES
            'iBarShift': [...ENUM_TIMEFRAMES],

            // iOpen(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iOpen': [...ENUM_TIMEFRAMES],

            // iClose(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iClose': [...ENUM_TIMEFRAMES],

            // iHigh(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iHigh': [...ENUM_TIMEFRAMES],

            // iLow(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iLow': [...ENUM_TIMEFRAMES],

            // iTime(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iTime': [...ENUM_TIMEFRAMES],

            // iVolume(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iVolume': [...ENUM_TIMEFRAMES],

            // iHighest(symbol, timeframe, type, count, start)
            // Param 2: ENUM_TIMEFRAMES
            'iHighest': [...ENUM_TIMEFRAMES],

            // iLowest(symbol, timeframe, type, count, start)
            // Param 2: ENUM_TIMEFRAMES
            'iLowest': [...ENUM_TIMEFRAMES],

            // SeriesInfoInteger(symbol, timeframe, prop_id)
            // Param 2: ENUM_TIMEFRAMES
            'SeriesInfoInteger': [...ENUM_TIMEFRAMES],

            // IndicatorCreate(symbol, period, indicator_type, ...)
            // Param 2: ENUM_TIMEFRAMES
            'IndicatorCreate': [...ENUM_TIMEFRAMES],

            // ---------------------------------------------------------------
            // TRADING FUNCTIONS (MQL5)
            // ---------------------------------------------------------------

            // OrderSend - uses MqlTradeRequest struct, but often appears in context
            // Suggest common trade action and order types
            'OrderSend': [
                ...ENUM_TRADE_REQUEST_ACTIONS,
                ...ENUM_ORDER_TYPE,
                ...ENUM_ORDER_FILLING
            ],

            // OrderCheck - same as OrderSend
            'OrderCheck': [
                ...ENUM_TRADE_REQUEST_ACTIONS,
                ...ENUM_ORDER_TYPE,
                ...ENUM_ORDER_FILLING
            ]
        };

        return ENUM_SUGGESTIONS[funcName] || [];
    }

    /**
     * Create spelling fix actions for misspelled function names
     * Uses Levenshtein distance to find closest matches
     *
     * QuickFix Title Pattern: "MQL: Did you mean '<function>'?"
     * - Machine-recognizable prefix: "MQL: Did you mean"
     * - Action: Replaces misspelled identifier with correct function name
     * - Safe: Yes (replaces text at error location)
     *
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diagnostic
     * @returns {vscode.CodeAction[]}
     */
    _createSpellingFixActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const col = diagnostic.range.start.character;

        // Try to extract identifier from error message first (clangd format: 'identifier')
        let misspelled = null;
        const msgMatch = diagnostic.message.match(/'(\w+)'/);
        if (msgMatch) {
            misspelled = msgMatch[1];
        }

        // Fallback: Extract from document at diagnostic position
        if (!misspelled) {
            const lineText = document.lineAt(line).text;
            const wordMatch = lineText.substring(col).match(/^(\w+)/);
            if (wordMatch) {
                misspelled = wordMatch[1];
            }
        }

        if (!misspelled) return actions;

        // Skip if too short (likely not a function name typo)
        if (misspelled.length < 4) return actions;

        // Find closest matches using Levenshtein distance
        const matches = findClosestMatches(misspelled, 2, 3);

        for (const match of matches) {
            const action = new vscode.CodeAction(
                `MQL: Did you mean '${match.name}'?`,
                vscode.CodeActionKind.QuickFix
            );

            action.edit = new vscode.WorkspaceEdit();

            // Calculate the exact range of the misspelled word
            const startPos = new vscode.Position(line, col);
            const endPos = new vscode.Position(line, col + misspelled.length);

            action.edit.replace(document.uri, new vscode.Range(startPos, endPos), match.name);
            action.diagnostics = [diagnostic];

            // Mark distance-1 matches as preferred (high confidence)
            if (match.distance === 1) {
                action.isPreferred = true;
            }

            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 4: Create actions to fix implicit number to string conversion
     *
     * QuickFix Title Pattern: "MQL: Wrap with IntegerToString()" or "MQL: Wrap with DoubleToString()"
     * - Machine-recognizable prefix: "MQL: Wrap with"
     * - Action: Wraps the numeric value at the diagnostic location with a conversion function
     * - Safe: Yes (wraps existing code)
     *
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diagnostic
     * @returns {vscode.CodeAction[]}
     */
    _createStringConversionActions(document, diagnostic) {
        const actions = [];
        const range = diagnostic.range;

        // Get the text at the diagnostic range
        const problematicText = document.getText(range);

        // Skip if already wrapped in a conversion function
        if (problematicText.includes('ToString(')) {
            return actions;
        }

        // Expand range to capture the full expression if it's short (single character like a number)
        let expandedRange = range;

        // If range is very small, try to find the full identifier/number
        if (range.end.character - range.start.character <= 1) {
            // Find word boundaries around the position
            const wordRange = document.getWordRangeAtPosition(range.start, /[\w.]+/);
            if (wordRange) {
                expandedRange = wordRange;
            }
        }

        const valueToWrap = document.getText(expandedRange);

        // Skip empty or already wrapped values
        if (!valueToWrap || valueToWrap.includes('ToString(')) {
            return actions;
        }

        // Create IntegerToString action
        const intAction = new vscode.CodeAction(
            'MQL: Wrap with IntegerToString()',
            vscode.CodeActionKind.QuickFix
        );
        intAction.edit = new vscode.WorkspaceEdit();
        intAction.edit.replace(
            document.uri,
            expandedRange,
            `IntegerToString(${valueToWrap})`
        );
        intAction.diagnostics = [diagnostic];
        actions.push(intAction);

        // Create DoubleToString action
        const doubleAction = new vscode.CodeAction(
            'MQL: Wrap with DoubleToString()',
            vscode.CodeActionKind.QuickFix
        );
        doubleAction.edit = new vscode.WorkspaceEdit();
        doubleAction.edit.replace(
            document.uri,
            expandedRange,
            `DoubleToString(${valueToWrap}, 8)`
        );
        doubleAction.diagnostics = [diagnostic];
        actions.push(doubleAction);

        // If it looks like an integer (no decimal point), prefer IntegerToString
        if (/^\d+$/.test(valueToWrap) || /^[A-Z_][A-Z0-9_]*$/.test(valueToWrap)) {
            intAction.isPreferred = true;
        } else if (valueToWrap.includes('.')) {
            doubleAction.isPreferred = true;
        }

        return actions;
    }
}

module.exports = { MqlCodeActionProvider };
