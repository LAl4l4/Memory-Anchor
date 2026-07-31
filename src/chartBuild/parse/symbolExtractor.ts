import {
    JS_EXPORT_LANGS,
    GENERIC_DECLARATIONS,
    FUNCTION_DECLARATION_TYPES,
    CLASS_DECLARATION_TYPES,
    INTERFACE_DECLARATION_TYPES,
    ENUM_DECLARATION_TYPES,
    TYPE_DECLARATION_TYPES
} from '../../constant.js';
import type { FileDependencyBinding, FileNode, FileSymbol } from '../shared/CBHTypes.js';

export type { FileDependencyBinding, FileNode, FileSymbol } from '../shared/CBHTypes.js';

export function extractSymbols(node: any, fileNode: FileNode) {
    for (const child of node.children) {
        const symbolInfo = getSymbolInfo(child, fileNode.language);
        if (symbolInfo) {
            fileNode.symbols.push(symbolInfo);
            // 只有当它是一个函数、接口、枚举或类型声明时，才停止深入子节点
            // 类声明我们允许继续深入，因为它可能包含方法定义，我们也想捕获到
            if (!CLASS_DECLARATION_TYPES.has(symbolInfo.type))
            continue;
        }

        extractSymbols(child, fileNode);
    }
}

export function getSymbolInfo(node: any, lang: string): FileSymbol | null {
    let isExported = false;

    // 针对 JavaScript/TypeScript 的 export 语法进行特殊处理
    if (JS_EXPORT_LANGS.has(lang) && node.type === "export_statement") {
        const target =
            node.namedChildren.find((c: any) =>
                GENERIC_DECLARATIONS.has(c.type)
            );
        if (!target) return null;
        node = target;
        isExported = true;
    }

    if (!GENERIC_DECLARATIONS.has(node.type)) return null;

    const name = getNodeName(node);
    if (!name) return null;

    // 🔥 核心修复 1：针对 C/C++ 等语言的 struct/enum/union 的特殊防护
    // 只有当它们包含 body（即 field_declaration_list）时，才算作真正的"类型定义"
    if (node.type === "struct_specifier" || node.type === "enum_specifier") {
        // childForFieldName 是 Tree-sitter 的原生方法，用来查找指定名称的子节点
        const hasBody = node.childForFieldName("body") !== null;
        if (!hasBody) return null; // 只是作为参数或变量类型使用，直接过滤掉
    }

    let type: string = node.type;
    if (FUNCTION_DECLARATION_TYPES.has(node.type)) {
        type = 'function_declaration';
    } else if (CLASS_DECLARATION_TYPES.has(node.type)) {
        type = 'class_declaration';
    } else if (INTERFACE_DECLARATION_TYPES.has(node.type)) {
        type = 'interface_declaration';
    } else if (ENUM_DECLARATION_TYPES.has(node.type)) {
        type = 'enum_declaration';
    } else if (TYPE_DECLARATION_TYPES.has(node.type)) {
        type = 'type_declaration';
    }

    if (isExported) {
        type = 'exported_' + type;
    }

    const signature = isExported && FUNCTION_DECLARATION_TYPES.has(node.type)
        ? getFunctionSignature(node)
        : {};

    return {
        type,
        name,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        ...signature,
        forwardDependencies: [],
        dependedOnBy: [],
    };

}

export function getNodeName(node: any): string | null {
    const nameNode = node.childForFieldName?.("name");
    if (nameNode?.text) return nameNode.text;

    const identifier = findIdentifier(node);
    return identifier?.text ?? null;
}

export function findIdentifier(node: any): any | null {
    if (!node?.namedChildren) return null;

    for (const child of node.namedChildren) {
        if (
            child.type === "identifier" ||
            child.type === "type_identifier" ||
            child.type === "field_identifier"
        ) {
            return child;
        }
    }

    for (const child of node.namedChildren) {
        const found = findIdentifier(child);
        if (found) return found;
    }

    return null;
}

function fieldText(node: any, fields: readonly string[]): string | undefined {
    for (const field of fields) {
        const value = node.childForFieldName?.(field)?.text;
        if (value) return value;
    }
    return undefined;
}

/** Extract explicit TypeScript-style function annotations directly from AST fields. */
function getFunctionSignature(node: any): Pick<FileSymbol, 'parameters' | 'returnType'> {
    const rawParameters = fieldText(node, ['parameters', 'formal_parameters']);
    // Parameter names alone do not help an agent call an exported API without
    // reading it. Retain the list only when it carries source type annotations.
    const parameters = rawParameters?.includes(':') ? rawParameters : undefined;
    const rawReturnType = fieldText(node, ['return_type', 'returnType']);
    const returnType = rawReturnType?.replace(/^\s*:\s*/, '').trim();

    return {
        ...(parameters ? { parameters } : {}),
        ...(returnType ? { returnType } : {}),
    };
}

function unquote(value: string): string {
    return value.replace(/^['\"`]|['\"`]$/g, '');
}

function sourceFromImportNode(node: any): string | null {
    const sourceNode = node.childForFieldName?.('source');
    if (sourceNode?.text) return unquote(sourceNode.text);

    const quoted = node.text.match(/['\"]([^'\"]+)['\"]/);
    if (quoted) return quoted[1];

    const pythonFrom = node.text.match(/^\s*from\s+([\w.]+)/m);
    return pythonFrom?.[1] ?? null;
}

function bindingsFromImportNode(node: any, source: string): FileDependencyBinding[] {
    const text = node.text;
    const bindings: FileDependencyBinding[] = [];
    const named = text.match(/\{([\s\S]*?)\}/);

    if (named) {
        for (const part of named[1].split(',')) {
            const [imported, local = imported] = part.trim().split(/\s+as\s+/);
            if (imported) bindings.push({ imported, local });
        }
    }

    const pythonFrom = text.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/m);
    if (pythonFrom) {
        for (const part of pythonFrom[1].split(',')) {
            const [imported, local = imported] = part.trim().split(/\s+as\s+/);
            if (imported && imported !== '*') bindings.push({ imported, local });
        }
    }

    // Default imports do not identify an exported symbol reliably, but the
    // file-level dependency is still retained through `source`.
    return bindings;
}

function callName(node: any): string | null {
    const functionNode = node.childForFieldName?.('function')
        ?? node.childForFieldName?.('name')
        ?? node.namedChildren?.[0];
    const text = functionNode?.text;
    return text && /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
}

function collectDependencyData(
    node: any,
    fileNode: FileNode,
    seenDependencies: Set<string>,
    containingSymbol: FileSymbol | undefined,
    seenForwardDependencies: Set<string>
): void {
    if (
        node.type === 'import_statement' ||
        node.type === 'import_declaration' ||
        node.type === 'import_from_statement' ||
        node.type === 'preproc_include'
    ) {
        const source = sourceFromImportNode(node);
        if (source && !seenDependencies.has(source)) {
            seenDependencies.add(source);
            fileNode.dependencies.push({
                source,
                bindings: bindingsFromImportNode(node, source),
            });
        }
    }

    if (node.type === 'call_expression' || node.type === 'method_invocation') {
        const name = callName(node);
        if (name && containingSymbol) {
            const key = `${containingSymbol.startIndex}\0${name}`;
            if (!seenForwardDependencies.has(key)) {
                seenForwardDependencies.add(key);
                containingSymbol.forwardDependencies.push(name);
            }
        }
    }
}

/**
 * Extract every serializable chart fact from one depth-first Tree-sitter walk.
 * The worker uses this instead of walking the already-parsed tree separately
 * for symbols and dependency data.
 */
export function extractFileArchitecture(root: any, fileNode: FileNode): void {
    const seenDependencies = new Set<string>();
    const seenForwardDependencies = new Set<string>();

    const visit = (
        node: any,
        containingSymbol: FileSymbol | undefined,
        skipOwnSymbol = false
    ): void => {
        let symbolInfo: FileSymbol | null = null;
        if (!skipOwnSymbol) {
            symbolInfo = getSymbolInfo(node, fileNode.language);
            if (symbolInfo) fileNode.symbols.push(symbolInfo);
        }
        const currentSymbol = symbolInfo ?? containingSymbol;
        collectDependencyData(
            node,
            fileNode,
            seenDependencies,
            currentSymbol,
            seenForwardDependencies
        );

        const exportedDeclaration = node.type === 'export_statement'
            ? node.namedChildren?.find((child: any) => GENERIC_DECLARATIONS.has(child.type))
            : undefined;
        for (const child of node.namedChildren ?? []) {
            visit(
                child,
                currentSymbol,
                child === exportedDeclaration && symbolInfo !== null
            );
        }
    };

    visit(root, undefined);
}
