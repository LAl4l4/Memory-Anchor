#!/usr/bin/env node
import { buildMemoryCore } from './memoryCore.js';
import { getHookInvocation, logHookFailed, logHookSucceeded, logHookTriggered } from './hookDebug.js';

export function loadMemoryCore(): string {
  const invocation = logHookTriggered(getHookInvocation());
  try {
    const memoryCore = buildMemoryCore(invocation.workdir);
    logHookSucceeded(invocation, `memory context injected (${Buffer.byteLength(memoryCore, 'utf8')} bytes)`);
    return memoryCore;
  } catch (error) {
    logHookFailed(invocation, error);
    throw error;
  }
}
