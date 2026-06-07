#!/usr/bin/env node
import { runStop } from '../public/stopPublic.js';
import { runSessionEnd } from '../public/sessionEndPublic.js';

void runSessionEnd();//because codex cli doesn't have session end
void runStop();
