# ArcGIS Pro add-in for view and cursor sync (REQ-GAP-65)

| Folder | What it is | Built here? |
|---|---|---|
| `contract/` | The wire contract, replayed by both sides | |
| `GwbProSync.Core/` | The add-in's client and loop: plain .NET, no ArcGIS reference | Yes |
| `MockAddin/` | The same code with a fake map, for tests | Yes |
| `GwbProSync/` | The add-in proper: `ProMapHost.cs`, `Module1.cs`, `Config.daml` | **No** |

ArcGIS Pro and its SDK need an account or a licence, so `GwbProSync/` has never been compiled or run. It
was written from the SDK's public documentation. Expect to fix it when it first meets the compiler.

## Building the add-in
On a computer with ArcGIS Pro 3.3 or later and the Pro SDK for .NET:

1. Create an empty add-in from the SDK's Visual Studio template, to get its packaging targets and an
   add-in id. Copy the id into `Config.daml`.
2. Add `ProMapHost.cs`, `Module1.cs` and `Config.daml`, and a project reference to `GwbProSync.Core`.
3. Build, and double-click the `.esriAddinX`.

## The test the owner runs
1. Start the sidecar. In GIS Workbench open a georeferenced image, then Sidecar ▸ Sync with ArcGIS Pro….
2. In Pro open a map, then GIS Workbench ▸ Sync with GIS Workbench. The first time, compare the six digits
   and press Allow in the sidecar window.
3. Pan and zoom in each program: the other follows, and neither drifts or keeps moving by itself.
4. Move the cursor over each map: a green cross follows on the other.
5. In the app, set the direction to each one-way choice: the follower stops publishing.
6. Rotate the map in Pro: check the app's rotation has the right sign (`ProMapHost.cs` assumes Pro's
   heading is counter-clockwise; this is the one number that cannot be checked here).
7. Compare the ground scale at several scales: `MetresPerPixelAtScale1` assumes 96 DPI. On a display at
   another DPI it will need Pro's own DPI.

Run `dotnet build -c Release MockAddin` to build the mock. It targets `net8.0`, as Pro does; on a computer
without that targeting pack, add `-p:GwbTfm=net10.0`.
