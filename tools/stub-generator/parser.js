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
        const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
        let match;

        while ((match = enumRegex.exec(source)) !== null) {
            const enumObj = new ParsedEnum(match[1]);
            const body = match[2];

            // Parse enum values
            const valueRegex = /(\w+)\s*(?:=\s*([^,\n]+))?/g;
            let valueMatch;
            while ((valueMatch = valueRegex.exec(body)) !== null) {
                if (valueMatch[1] && !valueMatch[1].match(/^\s*$/)) {
                    enumObj.values.push({
                        name: valueMatch[1].trim(),
                        value: valueMatch[2] ? valueMatch[2].trim() : null
                    });
                }
            }

            if (enumObj.values.length > 0) {
                this.enums.push(enumObj);
            }
        }
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

            // Parse the declaration
            this.parseDeclaration(fullDecl, classObj);
            i++;
        }
    }

    /**
     * Parse a single declaration (method or member)
     */
    parseDeclaration(decl, classObj) {
        // Skip implementation blocks
        if (decl.includes('{')) {
            return;
        }

        // Clean up declaration
        decl = decl.replace(/;.*$/, '').trim();
        if (!decl) return;

        // Check for method declaration
        const methodMatch = decl.match(
            /^(virtual\s+)?(static\s+)?(?:const\s+)?(\w+(?:\s*[*&])?(?:\s*<[^>]+>)?)\s+(\w+)\s*\(/
        );

        if (methodMatch) {
            // Find the '(' position and extract balanced parentheses
            const parenIndex = decl.indexOf('(');
            const paramStr = this.extractParenthesizedBlock(decl, parenIndex);
            const isConst = decl.slice(parenIndex + paramStr.length + 1).trim().startsWith('const');

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
        const ctorMatch = decl.match(new RegExp(`^${classObj.name}\\s*\\(`));
        if (ctorMatch) {
            // Find the '(' position and extract balanced parentheses
            const parenIndex = decl.indexOf('(');
            const paramStr = this.extractParenthesizedBlock(decl, parenIndex);

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
        const dtorMatch = decl.match(new RegExp(`^(virtual\\s+)?~${classObj.name}\\s*\\(`));
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

        // Check for member variable
        const memberMatch = decl.match(/^(static\s+)?(\w+(?:\s*[*&])?(?:\s*<[^>]+>)?)\s+(\w+)(?:\s*\[[^\]]*\])?/);
        if (memberMatch && !decl.includes('(')) {
            const member = {
                visibility: this.currentVisibility,
                isStatic: !!memberMatch[1],
                type: memberMatch[2].trim(),
                name: memberMatch[3]
            };
            classObj.members.push(member);
        }
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

