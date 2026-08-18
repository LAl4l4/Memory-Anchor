#!/usr/bin/env node
import { runSessionEnd } from '../public/sessionEndPublic.js';
import { isMemoryAnchorWorkspace } from './workspaceGuard.js';

if (isMemoryAnchorWorkspace()) {
  void runSessionEnd();
} else {
  process.exit(0);
}