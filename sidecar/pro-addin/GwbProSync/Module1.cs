// The add-in's module: pair once, follow the page, publish what the map does.
//
// NOT COMPILED OR RUN: see ProMapHost.cs. Written from the SDK's public documentation.

using ArcGIS.Desktop.Framework;
using ArcGIS.Desktop.Framework.Contracts;
using GwbProSync.Core;
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;

namespace GwbProSync
{
    internal sealed class Module1 : Module
    {
        const string ClientName = "ArcGIS Pro add-in";
        static readonly string TokenFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GIS Workbench Sidecar", "pro-addin.token");

        CancellationTokenSource? _cts;
        ProMapHost? _map;
        SyncClient? _client;
        SyncLoop? _loop;

        public static Module1 Current => (Module1)FrameworkApplication.FindModule("GwbProSync_Module");
        public string StatusText { get; private set; } = "Off";
        public bool IsOn => _cts is not null;

        /// <summary>The ribbon button: on or off. Nothing runs until the analyst presses it.</summary>
        public async Task ToggleAsync()
        {
            if (IsOn)
            {
                Stop();
                return;
            }
            var token = File.Exists(TokenFile) ? File.ReadAllText(TokenFile).Trim() : null;
            _client = await SyncClient.DiscoverAsync(token);
            if (_client is null)
            {
                MessageBox.Show("No GIS Workbench sidecar answered on this computer. Start it first.", "GIS Workbench");
                return;
            }
            var hello = await _client.HelloAsync();
            if (!hello.Paired && !await PairAsync(_client)) return;
            _cts = new CancellationTokenSource();
            var ct = _cts.Token;
            _map = new ProMapHost(v => _ = _loop?.LocalViewAsync(v, ct), s => StatusText = s);
            _loop = new SyncLoop(_client, _map);
            _ = _loop.RunAsync(ct);
            FrameworkApplication.Current.MainWindow.PreviewMouseMove += OnMouse;
        }

        void OnMouse(object sender, MouseEventArgs e)
        {
            var w = FrameworkApplication.Current.MainWindow;
            var c = ProMapHost.CursorAt(w.PointToScreen(e.GetPosition(w)));
            if (c is not null && _loop is not null) _ = _loop.LocalCursorAsync(c);
        }

        /// <summary>The same six digits appear here and in the sidecar window, as for a page.</summary>
        async Task<bool> PairAsync(SyncClient c)
        {
            var s = await c.PairStartAsync(ClientName);
            MessageBox.Show($"Check that the sidecar window shows {s.Code}, then press Allow there.", "Pair with GIS Workbench");
            for (var i = 0; i < 180; i++)
            {
                var st = await c.PairPollAsync(s.PairingId);
                if (st.State == "approved" && st.Token is not null)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(TokenFile)!);
                    File.WriteAllText(TokenFile, st.Token);
                    c.Token = st.Token;
                    return true;
                }
                if (st.State is "denied" or "expired") return false;
                await Task.Delay(1000);
            }
            return false;
        }

        void Stop()
        {
            FrameworkApplication.Current.MainWindow.PreviewMouseMove -= OnMouse;
            _cts?.Cancel();
            _cts = null;
            _map?.Dispose();
            _map = null;
            _client?.Dispose();
            _client = null;
            StatusText = "Off";
        }

        protected override bool CanUnload()
        {
            Stop();
            return true;
        }
    }

    internal sealed class SyncButton : Button
    {
        protected override async void OnClick()
        {
            await Module1.Current.ToggleAsync();
            IsChecked = Module1.Current.IsOn;
        }
    }
}
