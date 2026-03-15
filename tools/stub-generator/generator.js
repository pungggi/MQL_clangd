/**
 * Stub Generator
 * Generates clangd-compatible C++ stub declarations from parsed MQL5 structures
 */

'use strict';

class StubGenerator {
    constructor(options = {}) {
        this.indent = options.indent || '    ';
        this.includePrivate = options.includePrivate || false;
        this.includeProtected = options.includeProtected !== false; // default true
        this.addDocComments = options.addDocComments || false;
        // When true, only generate forward declarations (avoids conflicts with real headers)
        this.forwardDeclOnly = options.forwardDeclOnly || false;
        // When true, skip enum generation entirely (enums come from real MQL5 headers)
        this.skipEnums = options.skipEnums || false;
    }

    /**
     * Generate stubs from parsed data
     * @param {object} parsedData - Output from MqlParser.parse()
     * @returns {string} Generated C++ stub code
     */
    generate(parsedData) {
        const lines = [];

        // Header comment
        lines.push(`// Auto-generated stubs from: ${parsedData.filename}`);
        lines.push(`// Generated: ${new Date().toISOString()}`);
        lines.push('');

        // Generate enums (unless skipEnums is enabled)
        if (!this.skipEnums) {
            for (const enumObj of parsedData.enums) {
                lines.push(this.generateEnum(enumObj));
                lines.push('');
            }
        }

        // Generate classes (sorted by dependency)
        const sortedClasses = this.sortByDependency(parsedData.classes);
        for (const classObj of sortedClasses) {
            lines.push(this.generateClass(classObj));
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Generate enum declaration
     * Uses unscoped 'enum' to match MQL5's native enum behavior
     * (allows unqualified access like PERIOD_M1 and implicit int conversion)
     */
    generateEnum(enumObj) {
        const lines = [];
        lines.push(`enum ${enumObj.name} {`);

        const values = enumObj.values.map((v, i) => {
            const val = v.value !== null ? ` = ${v.value}` : '';
            const comma = i < enumObj.values.length - 1 ? ',' : '';
            return `${this.indent}${v.name}${val}${comma}`;
        });

        lines.push(...values);
        lines.push('};');

        return lines.join('\n');
    }

    /**
     * Common template parameter names used in MQL5/C++
     * These are identifiers that, if found in types without being defined,
     * indicate the class is a template.
     */
    static TEMPLATE_PARAMS = new Set([
        'T', 'K', 'V', 'U', 'R', 'E', 'N', 'M',
        'T1', 'T2', 'T3', 'T4', 'T5',
        'TKey', 'TItem', 'TValue', 'TResult', 'TInput', 'TOutput',
        'PURGER', 'FUNCTOR', 'COMPARATOR', 'ALLOCATOR'
    ]);

    /**
     * Detect template parameters used in a class
     * Scans all methods and members for type names that look like template parameters
     */
    detectTemplateParams(classObj) {
        const usedParams = new Set();

        // Helper to extract potential template params from a type string
        const extractParams = (typeStr) => {
            if (!typeStr) return;
            // Match standalone identifiers that could be template params
            // Look for: T, T*, T&, T[], const T, etc.
            const matches = typeStr.match(/\b([A-Z][A-Z0-9_]*)\b/g);
            if (matches) {
                for (const m of matches) {
                    if (StubGenerator.TEMPLATE_PARAMS.has(m)) {
                        usedParams.add(m);
                    }
                }
            }
        };

        // Check all methods
        for (const method of classObj.methods) {
            extractParams(method.returnType);
            for (const param of method.params || []) {
                extractParams(param.type);
            }
        }

        // Check all members
        for (const member of classObj.members) {
            extractParams(member.type);
        }

        // Return sorted array for consistent output
        return Array.from(usedParams).sort();
    }

    /**
     * Generate class/struct declaration
     */
    generateClass(classObj) {
        const lines = [];

        // Detect and generate template declaration if needed
        const templateParams = this.detectTemplateParams(classObj);
        if (templateParams.length > 0) {
            const templateDecl = templateParams.map(p => `typename ${p}`).join(', ');
            lines.push(`template<${templateDecl}>`);
        }

        // Class declaration
        const keyword = classObj.isStruct ? 'struct' : 'class';
        const inheritance = classObj.baseClass ? ` : public ${classObj.baseClass}` : '';
        lines.push(`${keyword} ${classObj.name}${inheritance} {`);

        // Group by visibility
        const publicMethods = classObj.methods.filter(m => m.visibility === 'public');
        const protectedMethods = classObj.methods.filter(m => m.visibility === 'protected');
        const privateMethods = classObj.methods.filter(m => m.visibility === 'private');

        const publicMembers = classObj.members.filter(m => m.visibility === 'public');
        const protectedMembers = classObj.members.filter(m => m.visibility === 'protected');
        const privateMembers = classObj.members.filter(m => m.visibility === 'private');

        // Public section
        if (publicMethods.length > 0 || publicMembers.length > 0) {
            lines.push('public:');
            for (const member of publicMembers) {
                lines.push(this.generateMember(member));
            }
            for (const method of publicMethods) {
                lines.push(this.generateMethod(method));
            }

            // Manual fixes for methods that might be missed by parser or require templates
            if (classObj.name === 'CArrayObj') {
                if (!publicMethods.some(m => m.name === 'At')) {
                    lines.push(this.indent + 'CObject *At(const int index) const;');
                }
            }
            if (classObj.name === 'CDictionary_String_Obj') {
                // Check if getter exists, if not add it (parser often skips overloads with same name)
                if (!publicMethods.some(m => m.name === 'Value' && (!m.params || m.params.length === 0))) {
                    lines.push(this.indent + 'CObject *Value();');
                }
            }
            if (classObj.name === 'CDictionary_Obj_Obj') {
                if (!publicMethods.some(m => m.name === 'Value' && (!m.params || m.params.length === 0))) {
                    lines.push(this.indent + 'CObject *Value();');
                }
                if (!publicMethods.some(m => m.name === 'Key' && (!m.params || m.params.length === 0))) {
                    lines.push(this.indent + 'CObject *Key();');
                }
            }
            if (classObj.name === 'CFileBin') {
                // Template methods are not currently parsed correctly
                lines.push(this.indent + 'template<typename T> uint WriteStruct(T &data);');
                lines.push(this.indent + 'template<typename T> uint WriteArray(T &array, const int start_item = 0, const int items_count = WHOLE_ARRAY);');
                lines.push(this.indent + 'template<typename T> uint WriteEnum(const T value);');
                lines.push(this.indent + 'template<typename T> uint ReadArray(T &array, const int start_item = 0, const int items_count = WHOLE_ARRAY);');
                lines.push(this.indent + 'template<typename T> bool ReadStruct(T &data);');
                lines.push(this.indent + 'template<typename T> bool ReadEnum(T &value);');
            }
        }

        // Protected section
        if (this.includeProtected && (protectedMethods.length > 0 || protectedMembers.length > 0)) {
            lines.push('protected:');
            for (const member of protectedMembers) {
                lines.push(this.generateMember(member));
            }
            for (const method of protectedMethods) {
                lines.push(this.generateMethod(method));
            }
        }

        // Private section (usually skip for stubs)
        if (this.includePrivate && (privateMethods.length > 0 || privateMembers.length > 0)) {
            lines.push('private:');
            for (const member of privateMembers) {
                lines.push(this.generateMember(member));
            }
            for (const method of privateMethods) {
                lines.push(this.generateMethod(method));
            }
        }

        lines.push('};');

        return lines.join('\n');
    }

    /**
     * Generate method declaration
     */
    generateMethod(method) {
        let decl = this.indent;

        if (method.isVirtual) decl += 'virtual ';
        if (method.isStatic) decl += 'static ';

        let safeReturnType = method.returnType;
        if (safeReturnType === 'INPUT_TYPE') safeReturnType = 'int';
        if (safeReturnType) decl += safeReturnType + ' ';

        decl += method.name + '(';
        decl += this.generateParams(method.params);
        decl += ')';

        if (method.isConst) decl += ' const';
        decl += ';';

        return decl;
    }

    /**
     * Generate parameter list
     */
    generateParams(params) {
        const CXX_KEYWORDS = new Set([
            'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case',
            'catch', 'char', 'char8_t', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const', 'consteval',
            'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype',
            'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern',
            'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace',
            'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected',
            'public', 'reflexpr', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof',
            'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local',
            'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual',
            'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq'
        ]);

        return params.map(p => {
            let param = '';
            if (p.isConst) param += 'const ';
            let safeType = p.type;
            if (safeType === 'INPUT_TYPE') safeType = 'int';
            param += safeType;

            if (p.name) {
                let safeName = p.name;
                if (CXX_KEYWORDS.has(safeName)) {
                    safeName = safeName + '_';
                }
                param += ' ' + safeName;
            }
            if (p.defaultValue !== undefined && p.defaultValue !== null) param += ' = ' + p.defaultValue;
            return param;
        }).join(', ');
    }

    /**
     * Generate member declaration
     */
    generateMember(member) {
        let decl = this.indent;
        if (member.isStatic) decl += 'static ';
        if (member.isConst) decl += 'const ';

        let safeType = member.type;
        if (safeType === 'INPUT_TYPE') safeType = 'int';

        decl += safeType + ' ' + member.name + ';';
        return decl;
    }

    /**
     * Sort classes by dependency (base classes and value member types first)
     */
    sortByDependency(classes) {
        const classMap = new Map(classes.map(c => [c.name, c]));
        const sorted = [];
        const visited = new Set();

        const visit = (classObj) => {
            if (visited.has(classObj.name)) return;
            visited.add(classObj.name);

            // Visit base class first
            if (classObj.baseClass && classMap.has(classObj.baseClass)) {
                visit(classMap.get(classObj.baseClass));
            }

            // Visit value member types (non-pointer, non-reference) first
            for (const member of classObj.members) {
                const typeName = member.type.replace(/[\s*&]+/g, ' ').trim().split(/\s+/)[0];
                // Only visit if it's a value type (no * or &) to avoid circular deps from pointers
                if (!member.type.includes('*') && !member.type.includes('&') && classMap.has(typeName)) {
                    visit(classMap.get(typeName));
                }
            }

            sorted.push(classObj);
        };

        for (const classObj of classes) {
            visit(classObj);
        }

        return sorted;
    }

    /**
     * Generate a complete header file
     */
    generateHeader(parsedDataArray, headerName = 'generated_stubs') {
        const lines = [];

        // File header
        lines.push('/**');
        lines.push(' * Auto-generated MQL5 Standard Library stubs for clangd');
        lines.push(` * Header: ${headerName}`);
        lines.push(` * Generated: ${new Date().toISOString()}`);
        lines.push(' * ');
        lines.push(' * DO NOT EDIT - This file is auto-generated by mql-stub-generator');
        lines.push(' */');
        lines.push('');
        lines.push('#pragma once');
        lines.push('');
        lines.push('#ifdef __clang__');
        lines.push('');

        // Forward declarations for all classes and their base classes
        const allClasses = [];
        const baseClasses = new Set();

        for (const data of parsedDataArray) {
            for (const cls of data.classes) {
                if (!allClasses.find(c => c.name === cls.name)) {
                    allClasses.push(cls);
                }
                if (cls.baseClass) {
                    baseClasses.add(cls.baseClass);
                }
            }
        }

        lines.push('// Forward declarations');
        // First, forward declare everything we have definitions for
        for (const cls of allClasses) {
            // Template classes cannot be forward-declared without template params
            const templateParams = this.detectTemplateParams(cls);
            if (templateParams.length > 0) {
                baseClasses.delete(cls.name);
                continue; // Skip — template definition itself serves as declaration
            }
            const keyword = cls.isStruct ? 'struct' : 'class';
            lines.push(`${keyword} ${cls.name};`);
            baseClasses.delete(cls.name); // Remove if we already declared it
        }

        // Collect value member types that aren't in allClasses (need forward decls too)
        const allClassNames = new Set(allClasses.map(c => c.name));
        for (const cls of allClasses) {
            for (const member of cls.members) {
                if (!member.type.includes('*') && !member.type.includes('&')) {
                    const typeName = member.type.replace(/[\s*&]+/g, ' ').trim().split(/\s+/)[0];
                    if (typeName && /^[A-Z]/.test(typeName) && !allClassNames.has(typeName)) {
                        baseClasses.add(typeName);
                    }
                }
            }
        }

        // Then, forward declare base classes that weren't in our definitions
        // (Assuming they are classes unless we know otherwise)
        if (baseClasses.size > 0) {
            lines.push('// Base classes from other headers');
            for (const base of baseClasses) {
                // Skip common built-in types that might be used as base but aren't classes
                if (['CObject', 'CArray', 'CList', 'CTreeNode'].includes(base)) {
                    lines.push(`class ${base};`);
                } else {
                    // MQL5 uses struct for many built-ins like MqlTradeRequest
                    const keyword = base.startsWith('Mql') ? 'struct' : 'class';
                    lines.push(`${keyword} ${base};`);
                }
            }
        }
        lines.push('');

        // Manual extras: constants, typedefs, and types not captured by the parser
        // (MQL5 macros, Windows API types, function pointer typedefs)
        lines.push('// Constants defined as macros in MQL5 headers');
        lines.push('const long CONTROLS_INVALID_ID = -1;');
        lines.push('const int CL_USE_ANY = -1;');
        lines.push('const int OBJ_ALL_PERIODS = -1;');
        lines.push('');
        lines.push('// Windows API types used in Win32 stubs');
        lines.push('typedef void* PVOID;');
        lines.push('typedef void* HANDLE;');
        lines.push('struct DISPLAYCONFIG_MODE { unsigned int modeInfoIdx; };');
        lines.push('struct RAWFORMAT { unsigned char data[16]; };');
        lines.push('struct FILETIME { unsigned int dwLowDateTime; unsigned int dwHighDateTime; };');
        lines.push('struct LUID { unsigned int LowPart; int HighPart; };');
        lines.push('struct FILE_ID_128 { unsigned char Identifier[16]; };');
        lines.push('');
        lines.push('// Function pointer typedefs used by CAxis/CCurve');
        lines.push('typedef double (*DoubleToStringFunction)(double value, void* cbdata);');
        lines.push('typedef double (*CurveFunction)(double x, void* cbdata);');
        lines.push('typedef void (*PlotFucntion)(void* cbdata);');
        lines.push('');
        lines.push('// OpenCL execution status (not in MQL5 public headers)');
        lines.push('enum ENUM_OPENCL_EXECUTION_STATUS {');
        lines.push('    OPENCL_EXECUTION_STATUS_SUBMITTED = 0,');
        lines.push('    OPENCL_EXECUTION_STATUS_RUNNING = 1,');
        lines.push('    OPENCL_EXECUTION_STATUS_COMPLETE = 2,');
        lines.push('    OPENCL_EXECUTION_STATUS_ERROR = -1');
        lines.push('};');
        lines.push('');
        lines.push('// Template forward declaration needed by CLinkedListNode');
        lines.push('template<typename T> class CLinkedList;');
        lines.push('');

        // Helper to check if two enums are identical
        const areEnumsEqual = (e1, e2) => {
            if (e1.values.length !== e2.values.length) return false;
            for (let i = 0; i < e1.values.length; i++) {
                if (e1.values[i].name !== e2.values[i].name) return false;
                if (e1.values[i].value !== e2.values[i].value) return false;
            }
            return true;
        };

        // Helper to update type references in classes when an enum is renamed
        const updateTypeReferences = (classes, oldName, newName) => {
            // Regex to match whole word type name
            const regex = new RegExp(`\\b${oldName}\\b`, 'g');
            const update = (s) => s ? s.replace(regex, newName) : s;

            for (const cls of classes) {
                for (const m of cls.members) {
                    m.type = update(m.type);
                }
                for (const m of cls.methods) {
                    m.returnType = update(m.returnType);
                    for (const p of m.params) {
                        p.type = update(p.type);
                    }
                }
            }
        };

        // Process enums: deduplicate and handle collisions (unless skipEnums is enabled)
        const finalEnums = [];
        if (!this.skipEnums) {
            const processedEnums = new Map(); // name -> enumObj

            for (const data of parsedDataArray) {
                for (const enumObj of data.enums) {
                    if (processedEnums.has(enumObj.name)) {
                        const existing = processedEnums.get(enumObj.name);
                        if (areEnumsEqual(existing, enumObj)) {
                            continue; // Exact duplicate, skip
                        } else {
                            // Collision! Rename current enum
                            const oldName = enumObj.name;
                            let counter = 2;
                            let newName = `${oldName}_${counter}`;
                            while (processedEnums.has(newName)) {
                                counter++;
                                newName = `${oldName}_${counter}`;
                            }

                            enumObj.name = newName;
                            processedEnums.set(newName, enumObj);
                            finalEnums.push(enumObj);

                            // Update references in this file's classes
                            updateTypeReferences(data.classes, oldName, newName);
                        }
                    } else {
                        processedEnums.set(enumObj.name, enumObj);
                        finalEnums.push(enumObj);
                    }
                }
            }

            // Generate all enums first
            lines.push('// Enums');
            for (const enumObj of finalEnums) {
                lines.push(this.generateEnum(enumObj));
                lines.push('');
            }
        }

        // Generate class definitions (unless forwardDeclOnly mode)
        if (!this.forwardDeclOnly) {
            lines.push('// Classes');
            const sortedClasses = this.sortByDependency(allClasses);
            for (const classObj of sortedClasses) {
                lines.push(this.generateClass(classObj));
                lines.push('');
            }
        } else {
            lines.push('// Forward declarations only mode - no class definitions');
            lines.push('// Include actual MQL5 headers for full definitions');
            lines.push('');
        }

        lines.push('#endif // __clang__');
        lines.push('');

        return lines.join('\n');
    }
}

module.exports = { StubGenerator };

