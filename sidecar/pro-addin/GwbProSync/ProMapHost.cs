// The only file that touches ArcGIS Pro's map: the view and the cursor, to and from WGS 84.
//
// NOT COMPILED OR RUN. ArcGIS Pro and its SDK need an account or a licence (owner item, REQ-GAP-65),
// so this file has been written from the SDK's public documentation and has never met the compiler.
// Everything below `IMapHost` is compiled and tested without it.

using ArcGIS.Core.CIM;
using ArcGIS.Core.Geometry;
using ArcGIS.Desktop.Framework.Threading.Tasks;
using ArcGIS.Desktop.Mapping;
using ArcGIS.Desktop.Mapping.Events;
using GwbProSync.Core;
using System;
using System.Threading.Tasks;

namespace GwbProSync
{
    internal sealed class ProMapHost : IMapHost, IDisposable
    {
        /// <summary>Pro's map scale is for 96 DPI: one pixel is 0.0254 / 96 m on paper.</summary>
        const double MetresPerPixelAtScale1 = 0.0254 / 96;

        readonly Action<SyncView> _localView;
        readonly Action<string> _status;
        readonly SubscriptionToken _camera;
        IDisposable? _cursorOverlay;

        public ProMapHost(Action<SyncView> localView, Action<string> status)
        {
            _localView = localView;
            _status = status;
            _camera = MapViewCameraChangedEvent.Subscribe(OnCamera);
        }

        public void Dispose()
        {
            MapViewCameraChangedEvent.Unsubscribe(_camera);
            _cursorOverlay?.Dispose();
        }

        void OnCamera(MapViewCameraChangedEventArgs e)
        {
            if (e.MapView is null || e.MapView != MapView.Active) return;
            QueuedTask.Run(() =>
            {
                var cam = e.CurrentCamera;
                var sr = e.MapView.Map.SpatialReference;
                var p = (MapPoint)GeometryEngine.Instance.Project(MapPointBuilderEx.CreateMapPoint(cam.X, cam.Y, sr), SpatialReferences.WGS84);
                _localView(new SyncView(p.X, p.Y, cam.Scale * MetresPerPixelAtScale1, -cam.Heading));
            });
        }

        public Task ApplyViewAsync(SyncView v) => QueuedTask.Run(async () =>
        {
            var mv = MapView.Active;
            if (mv is null) return;
            var sr = mv.Map.SpatialReference;
            var p = (MapPoint)GeometryEngine.Instance.Project(MapPointBuilderEx.CreateMapPoint(v.Lon, v.Lat, SpatialReferences.WGS84), sr);
            var cam = mv.Camera;
            cam.X = p.X;
            cam.Y = p.Y;
            cam.Scale = v.Mpp / MetresPerPixelAtScale1;
            cam.Heading = -v.Rotation;
            await mv.ZoomToAsync(cam, TimeSpan.Zero);
        });

        public void ShowCursor(SyncCursor c)
        {
            QueuedTask.Run(() =>
            {
                _cursorOverlay?.Dispose();
                _cursorOverlay = null;
                var mv = MapView.Active;
                if (mv is null || !c.Visible) return;
                var p = (MapPoint)GeometryEngine.Instance.Project(MapPointBuilderEx.CreateMapPoint(c.Lon, c.Lat, SpatialReferences.WGS84), mv.Map.SpatialReference);
                var sym = SymbolFactory.Instance.ConstructPointSymbol(ColorFactory.Instance.GreenRGB, 14, SimpleMarkerStyle.Cross);
                _cursorOverlay = mv.AddOverlay(p, sym.MakeSymbolReference());
            });
        }

        public void Status(string text) => _status(text);

        /// <summary>The add-in's pointer on the map, from the module's mouse hook.</summary>
        public static SyncCursor? CursorAt(System.Windows.Point screen)
        {
            var mv = MapView.Active;
            if (mv is null) return null;
            var p = mv.ScreenToMap(screen);
            if (p is null) return null;
            var g = (MapPoint)GeometryEngine.Instance.Project(p, SpatialReferences.WGS84);
            return new SyncCursor(g.X, g.Y, true);
        }
    }
}
