// .memoryanchor/core/types.ts

/**
 * sessionStart 钩子必须返回的响应体格式
 */
export interface SessionStartResponse {
    additionalContext: string;
}

/**
 * Git 状态捕获的数据结构
 */
export interface GitChange {
    status: 'M' | 'A' | '??' | string;
    file: string;
}