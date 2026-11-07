// REQ-CON-04: SigV4 signing matches AWS's published example (S3 API reference, "Example: GET
// Object" with a Range header) and maps s3:// and gs:// paths to path-style https URLs.
import { describe, it, expect } from 'vitest';
import { signV4 } from '../../app/src/connectors/sigv4.js';
import { httpsUrl } from '../../app/src/connectors/remote.js';

const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };

describe('SigV4', () => {
  it('signs the AWS example GET with a Range header', async () => {
    const { init } = await signV4('https://examplebucket.s3.amazonaws.com/test.txt', { headers: { Range: 'bytes=0-9' } }, creds, new Date(Date.UTC(2013, 4, 24, 0, 0, 0)));
    expect(init.headers.Authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(init.headers['x-amz-date']).toBe('20130524T000000Z');
    expect(init.headers.Range).toBe('bytes=0-9');
  });
  it('adds the session token when there is one', async () => {
    const { init } = await signV4('https://examplebucket.s3.amazonaws.com/test.txt', {}, { ...creds, sessionToken: 'TOKEN' }, new Date(Date.UTC(2013, 4, 24)));
    expect(init.headers['x-amz-security-token']).toBe('TOKEN');
    expect(init.headers.Authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  });
});

describe('cloud paths', () => {
  it('maps s3:// to path-style regional URLs and gs:// to storage.googleapis.com', () => {
    expect(httpsUrl('s3://maxar-opendata/events/a.tif')).toBe('https://s3.us-west-2.amazonaws.com/maxar-opendata/events/a.tif');
    expect(httpsUrl('s3://some-bucket/k.tif')).toBe('https://s3.amazonaws.com/some-bucket/k.tif');
    expect(httpsUrl('gs://gcp-public-data-landsat/x.TIF')).toBe('https://storage.googleapis.com/gcp-public-data-landsat/x.TIF');
    expect(httpsUrl('https://example.org/a.tif')).toBe('https://example.org/a.tif');
  });
});
