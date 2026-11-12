// Vitest setup file: its workers do not always run exit handlers, so remove each test file's
// temp folders when that file finishes (#228).
import { afterAll } from 'vitest';
import { removeTempDirs } from './temp-dir.mjs';

afterAll(removeTempDirs);
