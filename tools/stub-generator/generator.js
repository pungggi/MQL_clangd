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

        // Generate enums
        for (const enumObj of parsedData.enums) {
            lines.push(this.generateEnum(enumObj));
            lines.push('');
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
     * Generate class/struct declaration
     */
    generateClass(classObj) {
        const lines = [];

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

        // Generate all enums first
        lines.push('// Enums');
        for (const data of parsedDataArray) {
            for (const enumObj of data.enums) {
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

