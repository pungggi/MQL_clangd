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
     * Uses 'enum class' (scoped enum) to match MQL5's scoped enum behavior
     * and avoid enumerator name collisions in the global namespace
     */
    generateEnum(enumObj) {
        const lines = [];
        lines.push(`enum class ${enumObj.name} {`);

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
        'TKey', 'TValue', 'TResult', 'TInput', 'TOutput',
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
        if (method.returnType) decl += method.returnType + ' ';

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
        return params.map(p => {
            let param = '';
            if (p.isConst) param += 'const ';
            param += p.type;
            if (p.name) param += ' ' + p.name;
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
        decl += member.type + ' ' + member.name + ';';
        return decl;
    }

    /**
     * Sort classes by dependency (base classes first)
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
            const keyword = cls.isStruct ? 'struct' : 'class';
            lines.push(`${keyword} ${cls.name};`);
            baseClasses.delete(cls.name); // Remove if we already declared it
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
        lines.push('');
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

        // Process enums: deduplicate and handle collisions
        const processedEnums = new Map(); // name -> enumObj
        const finalEnums = [];

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

        // Generate all enums first (unless skipEnums is enabled)
        if (!this.skipEnums) {
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

