// TE-c17 Phase 2 functional coverage — files, projects, docks, preferences, packs, help (REQ-ARC, REQ-UI, REQ-HOST).
// Generic sweep: every catalogued command of this area runs on real corpus data in its ribbon
// context (tests/campaign/matrix-runner.js). Oracle-checked tests for this area are added below as
// the campaign executes (Part B, phase 3; see reports/campaign/matrix.md "Check" column).
import { runMatrix } from './matrix-runner.js';

runMatrix('c17-workspace');
