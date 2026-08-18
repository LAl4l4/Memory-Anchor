#!/usr/bin/env node
import { runStop } from '../public/stopPublic.js';
import { isMemoryAnchorWorkspace } from './workspaceGuard.js';

if (isMemoryAnchorWorkspace()) {
  void runStop();
} else {
  process.exit(0);
}