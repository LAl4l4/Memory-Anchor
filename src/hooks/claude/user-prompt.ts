#!/usr/bin/env node
import { getUserPromptAppendix } from '../public/userPromptAppend.js';

// Claude appends plain stdout from UserPromptSubmit as additional context.
process.stdout.write(getUserPromptAppendix());
