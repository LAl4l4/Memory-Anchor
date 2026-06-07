#!/usr/bin/env node
import { loadMemoryCore } from '../public/sessionStartPublic.js';

try {
  process.stdout.write(loadMemoryCore());
} catch (err) {
  process.stdout.write('Failed to load memory.');
}
process.exit(0);
