/**
 * MQL5 Header Parser
 * Parses MQL5 .mqh files and extracts class, struct, enum declarations
 */

'use strict';

/**
 * Represents a parsed class/struct
 */
class ParsedClass {
    constructor(name, baseClass = null, isStruct = false) {
        this.name = name;
        this.baseClass = baseClass;
        this.isStruct = isStruct;
        this.methods = [];      // { visibility, returnType, name, params, isVirtual, isConst, isStatic }
        this.members = [];      // { visibility, type, name }
        this.templateParams = null;
    }
}

/**
 * Represents a parsed enum
 */
class ParsedEnum {
    constructor(name) {
        this.name = name;
        this.values = [];       // { name, value }
    }
}

/**
 * MQL5 Parser - extracts declarations from .mqh files
 */
class MqlParser {
    constructor() {
        this.classes = [];
        this.enums = [];
        this.functions = [];
        this.currentVisibility = 'public';
    }

    /**
     * Parse MQL5 source code
     * @param {string} source - MQL5 source code
     * @param {string} filename - Source filename (for error messages)
     * @returns {object} Parsed declarations
     */
    parse(source, filename = 'unknown') {
        this.classes = [];
        this.enums = [];
        this.functions = [];

        // Remove comments
        source = this.removeComments(source);

        // Parse enums
        this.parseEnums(source);

        // Parse classes and structs
        this.parseClasses(source);

        return {
            classes: this.classes,
            enums: this.enums,
            functions: this.functions,
            filename
        };
    }

    /**
     * Remove C-style and C++-style comments
     */
    removeComments(source) {
        // Remove single-line comments
        source = source.replace(/\/\/.*$/gm, '');
        // Remove multi-line comments
        source = source.replace(/\/\*[\s\S]*?\*\//g, '');
        return source;
    }

    /**
     * Parse enum declarations
     */
    parseEnums(source) {
        let _pos = 0;
        const startRegex = /enum\s*(\w+)?\s*\{/g;
        let match;
        let anonCounter = 0;

        while ((match = startRegex.exec(source)) !== null) {
            const enumName = match[1] || `anonymous_enum_${++anonCounter}`;
            const startPos = match.index + match[0].length;

            // Use extractBracedBlock to get the body accurately
            const body = this.extractBracedBlock(source, startPos - 1);

            if (body !== null) {
                const enumObj = new ParsedEnum(enumName);
                this.parseEnumBody(body, enumObj);
                if (enumObj.values.length > 0) {
                    this.enums.push(enumObj);
                }
                // Advance regex to end of this enum
                startRegex.lastIndex = startPos + body.length;
            }
        }
    }

    /**
     * Parse the contents of an enum body
     */
    parseEnumBody(body, enumObj) {
        // Split by commas, but respect parentheses and nested braces
        const parts = this.splitByCommaOutsideParens(body);

        for (let part of parts) {
            part = part.trim();
            if (!part) continue;

            const eqIdx = part.indexOf('=');
            if (eqIdx !== -1) {
                const name = part.substring(0, eqIdx).trim();
                const value = part.substring(eqIdx + 1).trim();
                // Names must be valid identifiers
                if (name && /^[a-zA-Z_]\w*$/.test(name)) {
                    enumObj.values.push({
                        name: name,
                        value: value.replace(/\s+/g, ' ') // Normalize whitespace in values
                    });
                }
            } else {
                const name = part.trim();
                if (name && /^[a-zA-Z_]\w*$/.test(name)) {
                    enumObj.values.push({
                        name: name,
                        value: null
                    });
                }
            }
        }
    }

    /**
     * Splits a string by commas, but only those at the top level
     * (not inside parentheses, braces, or brackets)
     */
    splitByCommaOutsideParens(str) {
        const parts = [];
        let current = '';
        let depth = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];

            if (escaped) {
                escaped = false;
                current += char;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                current += char;
                continue;
            }
            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                current += char;
                continue;
            }
            if (char === '\'' && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                current += char;
                continue;
            }
            if (inSingleQuote || inDoubleQuote) {
                current += char;
                continue;
            }

            if (char === '(' || char === '{' || char === '[') depth++;
            else if (char === ')' || char === '}' || char === ']') depth--;
            else if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += char;
        }
        if (current.trim()) {
            parts.push(current);
        }
        return parts;
    }

    /**
     * Parse class and struct declarations
     */
    parseClasses(source) {
        // Match class/struct declaration with optional inheritance
        const classRegex = /(class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)?\s*(\w+))?\s*\{/g;
        let match;

        while ((match = classRegex.exec(source)) !== null) {
            const isStruct = match[1] === 'struct';
            const className = match[2];
            const baseClass = match[3] || null;

            // Find the class body
            const startPos = match.index + match[0].length;
            const body = this.extractBracedBlock(source, startPos - 1);

            if (body) {
                const classObj = new ParsedClass(className, baseClass, isStruct);
                this.parseClassBody(body, classObj);
                this.classes.push(classObj);
            }
        }
    }

    /**
     * Extract content between matching braces
     * String-aware: ignores braces inside string/char literals
     */
    extractBracedBlock(source, startPos) {
        let depth = 0;
        let start = -1;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = startPos; i < source.length; i++) {
            const char = source[i];

            // Handle escape sequences
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }

            // Handle quote state changes
            if (char === '\'' && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }
            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            // Skip brace counting when inside a quoted literal
            if (inSingleQuote || inDoubleQuote) {
                continue;
            }

            // Process braces only when not inside a string/char
            if (char === '{') {
                if (depth === 0) start = i + 1;
                depth++;
            } else if (char === '}') {
                depth--;
                if (depth === 0) {
                    return source.substring(start, i);
                }
            }
        }
        return null;
    }

    /**
     * Extract content between matching parentheses
     * String-aware: ignores parentheses inside string/char literals
     */
    extractParenthesizedBlock(source, startPos) {
        let depth = 0;
        let start = -1;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = startPos; i < source.length; i++) {
            const char = source[i];

            // Handle escape sequences
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }

            // Handle quote state changes
            if (char === '\'' && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }
            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            // Skip parenthesis counting when inside a quoted literal
            if (inSingleQuote || inDoubleQuote) {
                continue;
            }

            // Process parentheses only when not inside a string/char
            if (char === '(') {
                if (depth === 0) start = i + 1;
                depth++;
            } else if (char === ')') {
                depth--;
                if (depth === 0) {
                    return source.substring(start, i);
                }
            }
        }
        return null;
    }

    /**
     * Parse class body - extract methods and members
     */
    parseClassBody(body, classObj) {
        this.currentVisibility = classObj.isStruct ? 'public' : 'private';

        // Split by lines and process
        const lines = body.split('\n');
        let i = 0;

        while (i < lines.length) {
            let line = lines[i].trim();

            // Skip empty lines
            if (!line) {
                i++;
                continue;
            }

            // Check for visibility specifier
            if (line.match(/^(public|private|protected)\s*:/)) {
                this.currentVisibility = line.match(/^(public|private|protected)/)[1];
                i++;
                continue;
            }

            // Skip preprocessor directives
            if (line.startsWith('#')) {
                i++;
                continue;
            }

            // Collect multi-line declarations
            let fullDecl = line;
            while (!fullDecl.includes(';') && !fullDecl.includes('{') && i + 1 < lines.length) {
                i++;
                fullDecl += ' ' + lines[i].trim();
            }

            // If we hit an implementation block (method body), we need to:
            // 1. Extract just the signature part (before the '{')
            // 2. Skip past the entire method body
            if (fullDecl.includes('{')) {
                // Find where the brace starts in fullDecl
                const braceIdx = fullDecl.indexOf('{');
                const signature = fullDecl.substring(0, braceIdx).trim();

                // Parse the signature as a declaration (method or constructor)
                if (signature) {
                    this.parseDeclaration(signature + ';', classObj);
                }

                // Now skip past the entire method body
                // We need to find the matching closing brace
                // Rebuild the remaining text from current position
                const _remainingLines = lines.slice(i).join('\n');
                const _posInLine = fullDecl.indexOf('{');

                // Find where in 'remainingLines' the opening brace is
                // Actually, it's simpler to just count braces from where we are
                let braceDepth = 1;
                let skipLines = 0;
                let foundClosing = false;

                // Start scanning from the character after '{' in the current collected text
                // First, check if there's more content after '{' on the current line
                const afterBrace = fullDecl.substring(braceIdx + 1);
                for (const ch of afterBrace) {
                    if (ch === '{') braceDepth++;
                    else if (ch === '}') {
                        braceDepth--;
                        if (braceDepth === 0) {
                            foundClosing = true;
                            break;
                        }
                    }
                }

                // If not found, scan subsequent lines
                if (!foundClosing) {
                    for (let j = i + 1; j < lines.length; j++) {
                        skipLines++;
                        for (const ch of lines[j]) {
                            if (ch === '{') braceDepth++;
                            else if (ch === '}') {
                                braceDepth--;
                                if (braceDepth === 0) {
                                    foundClosing = true;
                                    break;
                                }
                            }
                        }
                        if (foundClosing) break;
                    }
                }

                // Advance past the method body
                i += skipLines;
            } else {
                // Parse the declaration (ends with ';')
                this.parseDeclaration(fullDecl, classObj);
            }

            i++;
        }
    }

    /**
     * C++ keywords that cannot start a valid member/method declaration.
     * These indicate implementation code that should be skipped.
     */
    static STATEMENT_KEYWORDS = new Set([
        'return', 'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
        'break', 'continue', 'goto', 'throw', 'try', 'catch', 'delete', 'new',
        'sizeof', 'typeof', 'alignof', 'decltype', 'nullptr', 'true', 'false',
        'this', 'using', 'typedef', 'namespace', 'template', 'typename',
        'Print', 'Alert', 'Comment', 'ArrayResize', 'ArrayCopy', 'ArrayFree',
        'StringFormat', 'DoubleToString', 'IntegerToString', 'TimeToString',
        'FileWrite', 'FileReadString', 'ChartRedraw', 'ObjectCreate',
        'SymbolInfoDouble', 'SymbolInfoInteger', 'SymbolInfoString',
        'OrderSend', 'OrderSelect', 'PositionSelect', 'PositionSelectByTicket',
        'HistorySelect', 'HistoryDealSelect', 'HistoryOrderSelect',
        'MathAbs', 'MathMax', 'MathMin', 'MathSqrt', 'MathPow', 'MathLog',
        'StringLen', 'StringSubstr', 'StringFind', 'StringReplace',
        'ArraySize', 'ArrayMaximum', 'ArrayMinimum', 'ArraySort',
        'Sleep', 'GetTickCount', 'GetMicrosecondCount', 'TimeCurrent',
        'NormalizeDouble', 'fabs', 'QuickSortTm'
    ]);

    /**
     * Parse a single declaration (method or member)
     */
    parseDeclaration(decl, classObj) {
        // Skip implementation blocks (shouldn't happen now, but keep as safety)
        if (decl.includes('{')) {
            return;
        }

        // Clean up declaration
        decl = decl.replace(/;.*$/, '').trim();
        if (!decl) return;

        // Extract first word to check against statement keywords
        const firstWordMatch = decl.match(/^(\w+)/);
        if (firstWordMatch && MqlParser.STATEMENT_KEYWORDS.has(firstWordMatch[1])) {
            return; // Skip - this is a statement, not a declaration
        }

        // Skip lines that look like expressions/statements (common patterns)
        // - Assignments: something = something
        // - Function calls without type: funcName(args)
        // - Comparisons: a == b, a != b, etc.
        // Note: Must not match valid declarations like "CObject* p;" or "int& r;" (Comment 7)
        if (/^\w+\s*[=!<>+\-*/]/.test(decl) && !/^(static\s+)?\w+.*\s+\w+\s*=/.test(decl)) {
            // This looks like an expression, not a declaration
            // Exception: static int x = 5; or int x = 5; are valid declarations
            return;
        }

        // Check for method declaration
        const methodMatch = decl.match(
            /^(virtual\s+)?(static\s+)?(?:const\s+)?(\w+(?:\s*[*&])?(?:\s*<[^>]+>)?)\s+(\w+)\s*\(/
        );

        if (methodMatch) {
            // Find the '(' position and extract balanced parentheses
            const parenIndex = decl.indexOf('(');
            const paramStr = this.extractParenthesizedBlock(decl, parenIndex);
            if (paramStr === null) return; // Malformed parentheses

            const afterParams = decl.slice(parenIndex + paramStr.length + 2).trim();
            const isConst = afterParams.startsWith('const');

            const method = {
                visibility: this.currentVisibility,
                isVirtual: !!methodMatch[1],
                isStatic: !!methodMatch[2],
                returnType: methodMatch[3].trim(),
                name: methodMatch[4],
                params: this.parseParams(paramStr),
                isConst: isConst
            };
            classObj.methods.push(method);
            return;
        }

        // Check for constructor
        const ctorMatch = decl.match(new RegExp(`^${this.escapeRegex(classObj.name)}\\s*\\(`));
        if (ctorMatch) {
            // Find the '(' position and extract balanced parentheses
            const parenIndex = decl.indexOf('(');
            const paramStr = this.extractParenthesizedBlock(decl, parenIndex);
            if (paramStr === null) return; // Malformed parentheses

            const method = {
                visibility: this.currentVisibility,
                isVirtual: false,
                isStatic: false,
                returnType: '',
                name: classObj.name,
                params: this.parseParams(paramStr),
                isConst: false,
                isConstructor: true
            };
            classObj.methods.push(method);
            return;
        }

        // Check for destructor
        const dtorMatch = decl.match(new RegExp(`^(virtual\\s+)?~${this.escapeRegex(classObj.name)}\\s*\\(`));
        if (dtorMatch) {
            const method = {
                visibility: this.currentVisibility,
                isVirtual: !!dtorMatch[1],
                isStatic: false,
                returnType: '',
                name: `~${classObj.name}`,
                params: [],
                isConst: false,
                isDestructor: true
            };
            classObj.methods.push(method);
            return;
        }

        // Check for member variable with stricter validation
        // Must be: [static] type name [array] [= value]
        // The type must be a valid identifier (not a keyword)
        const memberMatch = decl.match(/^(static\s+)?(const\s+)?(\w+(?:\s*[*&])?(?:\s*<[^>]+>)?)\s+(\w+)(?:\s*\[[^\]]*\])?(?:\s*=.*)?$/);
        if (memberMatch && !decl.includes('(')) {
            const typeName = memberMatch[3].trim();
            const varName = memberMatch[4];

            // Additional validation: type should not be a statement keyword
            const typeFirstWord = typeName.match(/^(\w+)/)?.[1];
            if (typeFirstWord && MqlParser.STATEMENT_KEYWORDS.has(typeFirstWord)) {
                return; // Skip - type looks like a keyword
            }

            // Variable name should not be a keyword
            if (MqlParser.STATEMENT_KEYWORDS.has(varName)) {
                return;
            }

            const member = {
                visibility: this.currentVisibility,
                isStatic: !!memberMatch[1],
                isConst: !!memberMatch[2],
                type: typeName,
                name: varName
            };
            classObj.members.push(member);
        }
    }

    /**
     * Escape special regex characters in a string
     */
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Parse method parameters
     */
    parseParams(paramStr) {
        if (!paramStr || !paramStr.trim()) {
            return [];
        }

        const params = [];
        const parts = this.splitParams(paramStr);

        for (const part of parts) {
            const param = this.parseParam(part.trim());
            if (param) {
                params.push(param);
            }
        }

        return params;
    }

    /**
     * Split parameter string by commas, respecting nested angle brackets
     */
    splitParams(paramStr) {
        const parts = [];
        let current = '';
        let depth = 0;

        for (const char of paramStr) {
            if (char === '<') depth++;
            else if (char === '>') depth--;
            else if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += char;
        }

        if (current.trim()) {
            parts.push(current);
        }

        return parts;
    }

    /**
     * Parse a single parameter
     */
    parseParam(paramStr) {
        if (!paramStr) return null;

        // Handle default values
        let defaultValue = null;
        if (paramStr.includes('=')) {
            const eqIndex = paramStr.indexOf('=');
            defaultValue = paramStr.substring(eqIndex + 1).trim();
            paramStr = paramStr.substring(0, eqIndex).trim();
        }

        // Parse type and name
        // Match: [const] type [&/*] name [array]
        const match = paramStr.match(/^(const\s+)?(\w+(?:\s*[*&])?(?:\s*<[^>]+>)?)\s*([&*]?)\s*(\w+)?(?:\s*\[[^\]]*\])?/);

        if (match) {
            return {
                isConst: !!match[1],
                type: (match[2] + (match[3] || '')).trim(),
                name: match[4] || '',
                defaultValue
            };
        }

        return null;
    }
}

module.exports = { MqlParser, ParsedClass, ParsedEnum };

