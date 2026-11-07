// REQ-GAP-70 View with Sidecar in the app: how a file reaches the sidecar, the activity indicator
// (OD-2.27) and Cancel. The route itself is tests/e2e/sidecar/26-codecs.spec.js.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../app/src/formats/open.js', () => ({ openImageFile: vi.fn(async () => ({ layers: [{ id: 'L1' }] })) }));
vi.mock('../../app/src/shell/dialogs.js', () => ({ modal: vi.fn(async () => 'cancel') }));
vi.mock('../../app/src/shell/dom.js', () => ({ h: () => ({}) }));

const { viewFile, COPY_LIMIT } = await import('../../app/src/features/sidecar-view.js');
const { openImageFile } = await import('../../app/src/formats/open.js');
const { modal } = await import('../../app/src/shell/dialogs.js');

const VIEW = { id: 'v'.repeat(24), name: 'a.sid', driver: 'MrSID', size: 1000, width: 10, height: 10, bands: 1, sample_type: 'Byte', levels: 1, tile: 512 };

function fixture({ activity = null, openView = async () => VIEW } = {}) {
  const calls = { upload: 0, pick: 0, close: [] };
  const client = {
    uploadSet: async () => (calls.upload++, { id: 'up' }),
    pick: async () => (calls.pick++, { files: [{ id: 'pk' }] }),
    openView: vi.fn(openView),
    closeView: async (id) => calls.close.push(id),
    viewUrl: (id) => `http://127.0.0.1:47821/v1/views/${id}`,
    signer: () => null,
  };
  const app = { toast: vi.fn(), activePane: () => null, layers: new Map([['L1', {}]]), on: vi.fn(), activity };
  const sc = { client, ready: async () => ({}), vendorCheck: vi.fn(), remoteFile: async () => ({ name: 'a.view.tif' }) };
  return { app, sc, client, calls };
}

describe('View with Sidecar', () => {
  it('copies a small file, picks when there is none, and names the check first', async () => {
    const f = fixture();
    const r = await viewFile(f.app, f.sc, { files: [{ name: 'a.sid', size: 10 }], reason: 'MrSID' });
    expect(f.calls.upload).toBe(1);
    expect(f.sc.vendorCheck).toHaveBeenCalledWith('a.sid', 'MrSID');
    expect(f.client.openView.mock.calls[0][0]).toBe('up');
    expect(r.layers[0].id).toBe('L1');
    const g = fixture();
    await viewFile(g.app, g.sc, {});
    expect([g.calls.pick, g.calls.upload]).toEqual([1, 0]);
    expect(g.client.openView.mock.calls[0][0]).toBe('pk');
  });

  it('asks before copying a large file; Cancel sends nothing', async () => {
    const f = fixture();
    expect(await viewFile(f.app, f.sc, { files: [{ name: 'big.sid', size: COPY_LIMIT + 1 }] })).toBeNull();
    expect(modal).toHaveBeenCalled();
    expect([f.calls.upload, f.calls.pick]).toEqual([0, 0]);
    expect(f.client.openView).not.toHaveBeenCalled();
  });

  it('reports the work to the activity indicator, with Cancel, and passes its signal on', async () => {
    const ac = new AbortController();
    const track = vi.fn(async (label, work) => work({ signal: ac.signal, cancelled: false, set() {} }));
    const f = fixture({ activity: { track } });
    await viewFile(f.app, f.sc, { files: [{ name: 'a.sid', size: 10 }] });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toEqual({ cancel: true });
    expect(f.client.openView.mock.calls[0][1].signal).toBe(ac.signal);
  });

  it('a cancelled open is no error; another failure is, and an old sidecar is named', async () => {
    const job = { signal: new AbortController().signal, cancelled: false };
    const f = fixture({
      activity: { track: async (l, work) => work(job) },
      openView: async () => {
        job.cancelled = true;
        throw new Error('the sidecar did not answer');
      },
    });
    expect(await viewFile(f.app, f.sc, { files: [{ name: 'a.sid', size: 10 }] })).toBeNull();
    const old = fixture({ openView: async () => { throw Object.assign(new Error('no such route'), { status: 404 }); } });
    await expect(viewFile(old.app, old.sc, { files: [{ name: 'a.sid', size: 10 }] })).rejects.toThrow(/too old/);
  });

  it('closes the view when the file cannot be opened', async () => {
    openImageFile.mockRejectedValueOnce(new Error('bad tiff'));
    const f = fixture();
    await expect(viewFile(f.app, f.sc, { files: [{ name: 'a.sid', size: 10 }] })).rejects.toThrow('bad tiff');
    expect(f.calls.close).toEqual([VIEW.id]);
  });
});
