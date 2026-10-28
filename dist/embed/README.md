# GIS Workbench embed kit (build feb8e261b0de1379)

Paste `snippet.html` into a hosting service's HTML/embed box, or host `gis-workbench.html` and embed it with
`<iframe src="gis-workbench.html" allow="fullscreen; clipboard-read; clipboard-write; display-capture"></iframe>`.

Snippet size: 6035345 bytes (snippet.html); Lite: 3966308 bytes (snippet-lite.html, REQ-HOST-05).
The Lite profile is the same application without the 3D, LiDAR, video and SAR modules, packed as one gzip payload behind a small loader; it starts a little slower.

## What works where (REQ-HOST-08)
| Attribute | Unlocks |
|---|---|
| `allow="fullscreen"` | Exploitation Fullscreen |
| `allow="clipboard-read; clipboard-write"` | Copy/paste of coordinates and graphics, export panel copy |
| `allow="display-capture"` | Whiteboard tab capture (otherwise a rendered snapshot is used) |
| `sandbox` with `allow-downloads` | Saving products and project files as downloads |
| `sandbox` with `allow-same-origin` | IndexedDB recovery journal and whiteboard sessions |

Without them the tool still runs and says what is unavailable (Help ▸ About & Diagnostics).
The tool keeps its own strict CSP inside the frame and never relaxes it (REQ-HOST-06).
