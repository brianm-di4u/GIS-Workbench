import { describe, expect, it } from 'vitest';
import { remapCargoHome } from '../../build/rust.mjs';

describe('remapCargoHome', () => {
  it('maps the cargo home to /cargo through a TOML literal string, backslashes and all', () => {
    const win = String.raw`C:\Users\someone\.cargo`;
    expect(win).toContain('\\');
    expect(remapCargoHome(win)).toEqual(['--config', String.raw`target.wasm32-unknown-unknown.rustflags=['--remap-path-prefix=C:\Users\someone\.cargo=/cargo']`]);
    expect(remapCargoHome('/home/runner/.cargo')).toEqual(['--config', "target.wasm32-unknown-unknown.rustflags=['--remap-path-prefix=/home/runner/.cargo=/cargo']"]);
  });

  it('refuses a path that would end the TOML string', () => {
    expect(() => remapCargoHome(String.raw`C:\Users\o'brien\.cargo`)).toThrow(/quote/);
  });
});
