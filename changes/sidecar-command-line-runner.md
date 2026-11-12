### Added
- **Command-line runner:** the sidecar now has `gwb-run`, which runs a recipe with no page open, in your installed Chrome or Edge. `gwb-sidecar run` does the same with no window, for Task Scheduler. Nothing listens on a network port. (REG-150)
- **Scheduled runs:** the runner guide shows how to run a recipe every night with Task Scheduler, cron or a systemd timer. The sidecar registers no task itself. (REG-151)

### Changed
- **API reference:** the TypeScript reference is now `gisworkbench-api-3.d.ts`, named for API 3.0.0. The old name, `gisworkbench-api-v2.d.ts`, still works for one release. (REG-179)

### Fixed
- **Sidecar creation options** whose value has an `&` or `<` in it stay one value. They were split in two.
