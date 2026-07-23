#!/usr/bin/env node
import { USER_PROMPT_APPENDIX } from '../public/userPromptAppend.js';

// Claude appends plain stdout from UserPromptSubmit as additional context.
process.stdout.write(USER_PROMPT_APPENDIX);
