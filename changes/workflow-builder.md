### Added
- **Workflow Builder.** Add-Ins ▸ Recipes ▸ Workflow Builder wires steps into a workflow, each output to the next step's input, with its types checked. Buffer, overlay, dissolve, join, the hydrology steps, endmembers and export are steps of their own. A workflow is saved in the project and in your library in this browser, runs again on new inputs, and is shared as a .gwrecipe.json file. Every layer it makes records the workflow, its version, the step and its settings. When a project and your library hold different workflows under the same id, the Recipes picker lists both, marked project and library, and API v2 recipes.run asks which with source: nothing is replaced without your choice.

### Changed
- **Recipes are kept in a library with no limit.** The recipes you open or save are kept in this browser's library, where the settings kept only the last 20. Recipes from the settings move there the first time.
