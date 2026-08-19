#!/usr/bin/env node
import { getUserPromptAppendix } from '../public/userPromptAppend.js';

process.stdout.write(getUserPromptAppendix());
