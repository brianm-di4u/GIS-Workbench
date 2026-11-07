# GIS Workbench embed kit (build 7a48ea70b1c18182)

Paste `snippet.html` into a hosting service's HTML/embed box, or host `gis-workbench.html` and embed it with
`<iframe src="gis-workbench.html" allow="fullscreen; clipboard-read; clipboard-write; display-capture"></iframe>`.

Snippet size: 9381132 bytes (snippet.html); Lite: 3702015 bytes (snippet-lite.html, REQ-HOST-05).
GIS Workbench Lite (OD-2.23) is the mobile edition: a touch interface for phones and tablets with the field features (open, view, enhance, coordinates, measure, AOI and GRG, observations with photos, export and share), packed as one gzip payload behind a small loader. It suits small embed boxes. GIS Workbench (Full) has every feature and the desktop interface.

## What works where (REQ-HOST-08)
| Attribute | Unlocks |
|---|---|
| `allow="fullscreen"` | Analysis Fullscreen |
| `allow="clipboard-read; clipboard-write"` | Copy/paste of coordinates and graphics, export panel copy |
| `allow="display-capture"` | Whiteboard tab capture (otherwise a rendered snapshot is used) |
| `sandbox` with `allow-downloads` | Saving products and project files as downloads |
| `sandbox` with `allow-same-origin` | IndexedDB recovery journal and whiteboard sessions |

Without them the tool still runs and says what is unavailable (Help ▸ About & Diagnostics).
The tool keeps its own strict CSP inside the frame and never relaxes it (REQ-HOST-06).
