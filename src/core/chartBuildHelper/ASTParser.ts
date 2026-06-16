import * as fs from 'fs';
import * as path from 'path';
import { Parser } from "web-tree-sitter";
import { loadLanguage, getAvailableParsers } from '../parser-loader.js';
import { EXT_TO_LANGUAGE } from '../../utils/ext-to-lang.js';
import { JS_EXPORT_LANGS, GENERIC_DECLARATIONS, FUNCTION_DECLARATION_TYPES, CLASS_DECLARATION_TYPES, INTERFACE_DECLARATION_TYPES, ENUM_DECLARATION_TYPES, TYPE_DECLARATION_TYPES } from '../../constant.js';

let initialized = false;

export async function ensureParserInit() {
    if (!initialized) {
        await Parser.init();
        initialized = true;
    }
}

export interface FileSymbol {
    type: string;
    name: string;
}

export interface FileNode {
    relativePath: string;
    language: string;
    symbols: FileSymbol[];
}

export async function parseFileArchitecture(
  absolutePath: string,
  relativePath: string
): Promise<FileNode> {

    const fileNode: FileNode = {
        relativePath,
        language: '',
        symbols: []
    };

    const ext = path.extname(absolutePath);
    const lang = EXT_TO_LANGUAGE[ext];

    if (!lang) return fileNode;

    const availableParsers = getAvailableParsers();
    if (!availableParsers.has(lang)) return fileNode;

    try {
        const code = fs.readFileSync(absolutePath, "utf-8");

        await ensureParserInit();
        const parser = new Parser();
        const language = await loadLanguage(lang);
        parser.setLanguage(language);

        const tree = parser.parse(code);

        if (!tree || !tree.rootNode) {
            process.stderr.write(`\x1b[31m[Memory Anchor] ⚠️ Failed to parse ${relativePath}\x1b[0m\n`);
            return fileNode;
        }

        fileNode.language = lang;

        extractSymbols(tree.rootNode, fileNode);

    } catch (err) {
        console.error(err);

        fileNode.symbols.push({
            type: "error",
            name: String(err)
        });
    }

    return fileNode;
}

function extractSymbols(node: any, fileNode: FileNode) {
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

function getSymbolInfo(node: any, lang: string): FileSymbol | null {
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

    return { type, name };

}

export function formatSymbol(exp: FileSymbol): string {
    switch (exp.type) {
        case 'function_declaration':
            return `- function ${exp.name}()`;

        case 'class_declaration':
            return `- class ${exp.name}`;

        case 'interface_declaration':
            return `- interface ${exp.name}`;

        case 'enum_declaration':
            return `- enum ${exp.name}`;

        case 'type_declaration':
            return `- type ${exp.name}`;

        case 'exported_function_declaration':
            return `- export function ${exp.name}()`;

        case 'exported_class_declaration':
            return `- export class ${exp.name}`;

        case 'exported_interface_declaration':
            return `- export interface ${exp.name}`;

        case 'exported_enum_declaration':
            return `- export enum ${exp.name}`;

        case 'exported_type_declaration':
            return `- export type ${exp.name}`;

        default:
            return `- ${exp.name}`;
    }
}

function getNodeName(node: any): string | null {
    const nameNode = node.childForFieldName?.("name");
    if (nameNode?.text) return nameNode.text;

    const identifier = findIdentifier(node);
    return identifier?.text ?? null;
}

function findIdentifier(node: any): any | null {
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
